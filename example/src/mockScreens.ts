import type { ScreenData, TerminalProtocol } from 'green-screen-react'

function pad(line: string, cols: number): string {
  return line.padEnd(cols).slice(0, cols)
}

function buildScreen(lines: string[], rows: number, cols: number, cursorRow: number, cursorCol: number): ScreenData {
  const padded = Array.from({ length: rows }, (_, i) => pad(lines[i] ?? '', cols))
  return {
    content: padded.join('\n'),
    cursor_row: cursorRow,
    cursor_col: cursorCol,
    rows,
    cols,
    fields: [{ row: cursorRow, col: cursorCol, length: cols - cursorCol, is_input: true, is_protected: false }],
  }
}

const tn5250Lines = [
  '  QSYS/DSPMOD                                         SYSTEM1       ',
  '                          IBM i Main Menu                            ',
  '                                                                     ',
  '  Select one of the following:                                       ',
  '                                                                     ',
  '      1. User tasks                                                  ',
  '      2. Office tasks                                                ',
  '      3. General system tasks                                        ',
  '      4. Files, libraries, and folders                               ',
  '      5. Programming                                                 ',
  '      6. Communications                                              ',
  '      7. Define or change the system                                 ',
  '      8. Problem handling                                            ',
  '      9. Display a menu                                              ',
  '     10. Information Assistant options                                ',
  '     11. iSeries Access tasks                                        ',
  '                                                                     ',
  '     90. Sign off                                                    ',
  '                                                                     ',
  '  Selection or command                                               ',
  '  ===>                                                               ',
  '                                                                     ',
  '  F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel                     ',
  '  F13=Information Assistant   F23=Set initial menu                   ',
]

const tn3270Lines = [
  '  Menu  Utilities  Compilers  Options  Status  Help                  ',
  ' ──────────────────────────────────────────────────────────────────── ',
  '                   ISPF Primary Option Menu                          ',
  '                                                                     ',
  '  0  Settings      Terminal and user parameters                      ',
  '  1  View          Display source data or listings                   ',
  '  2  Edit          Create or change source data                      ',
  '  3  Utilities     Perform utility functions                         ',
  '  4  Foreground    Interactive language processing                   ',
  '  5  Batch         Submit job for language processing                ',
  '  6  Command       Enter TSO or Workstation commands                 ',
  '  7  Dialog Test   Perform dialog testing                            ',
  '  8  LM Facility   Library Administrator                             ',
  '  9  IBM Products  IBM program development products                  ',
  '  10 SCLM          SW Configuration Library Manager                  ',
  '  11 Workplace     ISPF Object/Action Workplace                     ',
  '                                                                     ',
  '  Enter X to Terminate using log/list defaults                       ',
  '                                                                     ',
  '  Option ===>                                                        ',
  '  F1=Help  F2=Split  F3=Exit  F7=Backward  F8=Forward               ',
  '  F9=Swap  F10=Actions  F12=Cancel                                   ',
  '                                                                     ',
  '  z/OS 2.5  TSO     7 2026/03/15 15:30                              ',
]

const vtLines = [
  'OpenVMS V8.4-2L2 on node VENUS',
  'Last interactive login on Saturday, 15-MAR-2026 10:22',
  '',
  '$ ls -la',
  'total 48',
  'drwxr-xr-x  6 user  staff   192 Mar 15 10:30 .',
  'drwxr-xr-x  3 root  staff    96 Jan  5 09:00 ..',
  '-rw-r--r--  1 user  staff   220 Jan  5 09:00 .bash_profile',
  '-rw-------  1 user  staff  1024 Mar 15 10:28 .history',
  'drwxr-xr-x  4 user  staff   128 Mar 10 14:22 documents',
  'drwxr-xr-x  2 user  staff    64 Feb 28 08:15 logs',
  '-rwxr-xr-x  1 user  staff  4096 Mar 14 16:40 server.py',
  '-rw-r--r--  1 user  staff   512 Mar 12 11:00 config.yaml',
  '',
  '$ whoami',
  'user',
  '',
  '$ uname -a',
  'OpenVMS VENUS V8.4-2L2 Alpha',
  '',
  '$ date',
  'Sunday, 15 March 2026  3:30:00 PM',
  '',
  '$',
]

const hp6530Lines = [
  'HP NonStop Guardian  TACL - T9255                      \\NODE1.$ZHOME',
  '──────────────────────────────────────────────────────────────────────',
  '',
  '1> STATUS *,TERM',
  '',
  'SYSTEM  \\NODE1',
  'PID     Name            State    Pri PFR   %WT   CTIME',
  '0,123   $ZHOME          RUNNING  140  0      0   0:12:34',
  '0,456   $ZTN0           RUNNING  148  0      0   0:45:22',
  '1,201   $SPLS           RUNNING  155  0      0   1:03:11',
  '2,050   $ZLOG           RUNNING  150  0      0   3:22:05',
  '',
  '2> FILEINFO $ZHOME.*',
  '',
  'Code  EOF    Last Modify   Name',
  '101   2048   15Mar2026 15:20  CONFIG',
  '101   8192   14Mar2026 09:10  USERLIB',
  '100   1024   10Mar2026 14:30  STARTCMDS',
  '',
  '3>',
  '',
  'F1-Help  F2-Print  F4-Edit  F8-Home  F15-Abort  SF16-Status',
  '                                                                     ',
  '                                                                     ',
]

export const mockScreens: Record<TerminalProtocol, ScreenData> = {
  tn5250: buildScreen(tn5250Lines, 24, 80, 20, 8),
  tn3270: buildScreen(tn3270Lines, 24, 80, 19, 12),
  vt: buildScreen(vtLines, 24, 80, 23, 2),
  hp6530: buildScreen(hp6530Lines, 24, 80, 19, 3),
}
