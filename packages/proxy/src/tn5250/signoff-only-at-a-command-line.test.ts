import { describe, it, expect, vi } from 'vitest';
import { TN5250Handler } from '../protocols/tn5250-handler.js';
import { CMD, ORDER } from './constants.js';

// The graceful exit (a proxy shutdown drain, a plain /disconnect) types
// SIGNOFF + Enter. It used to type into the WIDEST input of whatever screen
// was up — on a data-entry record that is one of the record's fields, and the
// Enter submits the record on a host that commits on Enter. It now types only
// on a screen whose one input is a command line (an IBM i menu); anything else
// is closed without typing.

const ESC = 0x04;

function gdsRecord(data: number[]): Buffer {
  const header = [0, 0, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03];
  const body = [...header, ...data];
  body[0] = (body.length >> 8) & 0xff;
  body[1] = body.length & 0xff;
  return Buffer.from(body);
}

function inputField(row: number, col: number, len: number): number[] {
  return [ORDER.SBA, row, col - 1, ORDER.SF, 0x40, 0x00, 0x24, (len >> 8) & 0xff, len & 0xff];
}

function screen(fields: Array<[number, number, number]>): Buffer {
  const orders = fields.flatMap(([r, c, l]) => inputField(r, c, l));
  return gdsRecord([ESC, CMD.CLEAR_UNIT, ESC, CMD.WRITE_TO_DISPLAY, 0x00, 0x08, ...orders,
    ESC, CMD.READ_MDT_FIELDS, 0x00, 0x00]);
}

function connectedHandler(record: Buffer) {
  const h = new TN5250Handler();
  h.parser.parseRecord(record);
  vi.spyOn(h.connection, 'isConnected', 'get').mockReturnValue(true);
  const sent = vi.spyOn(h.connection, 'sendRaw').mockImplementation(() => {});
  return { h, sent };
}

describe('the graceful sign-off types only at a command line', () => {
  it('signs off from a menu whose one input is the command line', async () => {
    const { h, sent } = connectedHandler(screen([[20, 7, 153]]));
    expect(await h.attemptSignOff(10)).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    h.destroy();
  });

  it('types nothing on a record screen, however wide its fields', async () => {
    const { h, sent } = connectedHandler(screen([[5, 30, 10], [7, 30, 40], [9, 30, 25]]));
    expect(await h.attemptSignOff(10)).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(h.screen.readFieldValues(true)).toEqual([]);
    h.destroy();
  });

  it('types nothing on a list with an option column beside the command line', async () => {
    const { h, sent } = connectedHandler(screen([[8, 3, 1], [9, 3, 1], [20, 7, 153]]));
    expect(await h.attemptSignOff(10)).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    h.destroy();
  });
});
