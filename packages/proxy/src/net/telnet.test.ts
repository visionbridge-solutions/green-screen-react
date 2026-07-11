import { describe, it, expect } from 'vitest';
import { TELNET, TelnetRecordStream, type TelnetStreamSink } from './telnet.js';

const { IAC, EOR, SB, SE, DO, WILL } = TELNET;

function collect() {
  const negotiations: Array<[number, number]> = [];
  const subnegs: Buffer[] = [];
  const records: Buffer[] = [];
  const sink: TelnetStreamSink = {
    onNegotiation: (cmd, option) => negotiations.push([cmd, option]),
    onSubnegotiation: (data) => subnegs.push(Buffer.from(data)),
    onRecord: (record) => records.push(Buffer.from(record)),
  };
  return { sink, negotiations, subnegs, records };
}

describe('TelnetRecordStream', () => {
  it('extracts a record split across arbitrary chunk boundaries', () => {
    const { sink, records } = collect();
    const stream = new TelnetRecordStream(sink);
    const record = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wire = Buffer.concat([record, Buffer.from([IAC, EOR])]);
    for (const byte of wire) stream.feed(Buffer.from([byte])); // worst case: 1-byte chunks
    expect(records).toEqual([record]);
  });

  it('dispatches negotiation and subnegotiation interleaved with records', () => {
    const { sink, negotiations, subnegs, records } = collect();
    const stream = new TelnetRecordStream(sink);
    stream.feed(
      Buffer.concat([
        Buffer.from([IAC, DO, TELNET.OPT_TTYPE]),
        Buffer.from([IAC, SB, TELNET.OPT_TTYPE, TELNET.TTYPE_SEND, IAC, SE]),
        Buffer.from([0x11, 0x22, IAC, EOR]),
        Buffer.from([IAC, WILL, TELNET.OPT_EOR]),
      ]),
    );
    expect(negotiations).toEqual([
      [DO, TELNET.OPT_TTYPE],
      [WILL, TELNET.OPT_EOR],
    ]);
    expect(subnegs).toEqual([Buffer.from([TELNET.OPT_TTYPE, TELNET.TTYPE_SEND])]);
    expect(records).toEqual([Buffer.from([0x11, 0x22])]);
  });

  it('does not stall when a record STARTS with an escaped IAC IAC', () => {
    // Regression: the old per-protocol scanners bailed out ("break") on a
    // leading IAC IAC and never reached record extraction — permanent stall.
    const { sink, records } = collect();
    const stream = new TelnetRecordStream(sink);
    stream.feed(Buffer.from([IAC, IAC, 0x55, IAC, EOR]));
    expect(records).toEqual([Buffer.from([0xff, 0x55])]);
  });

  it('does not misread escaped IAC followed by a 0xEF data byte as end-of-record', () => {
    // Regression: IAC IAC 0xEF used to match "IAC EOR" at the second IAC,
    // truncating the record. 0xEF here is ordinary data.
    const { sink, records } = collect();
    const stream = new TelnetRecordStream(sink);
    stream.feed(Buffer.from([0x01, IAC, IAC, EOR, 0x02, IAC, EOR]));
    expect(records).toEqual([Buffer.from([0x01, 0xff, EOR, 0x02])]);
  });

  it('skips escaped IAC pairs while hunting for the subnegotiation end', () => {
    const { sink, subnegs } = collect();
    const stream = new TelnetRecordStream(sink);
    stream.feed(Buffer.from([IAC, SB, 0x28, 0x02, IAC, IAC, 0x07, IAC, SE]));
    expect(subnegs).toEqual([Buffer.from([0x28, 0x02, IAC, IAC, 0x07])]);
  });

  it('swallows empty records (bare IAC EOR)', () => {
    const { sink, records } = collect();
    const stream = new TelnetRecordStream(sink);
    stream.feed(Buffer.from([IAC, EOR, IAC, EOR, 0x09, IAC, EOR]));
    expect(records).toEqual([Buffer.from([0x09])]);
  });

  it('reset() drops partially accumulated state', () => {
    const { sink, records } = collect();
    const stream = new TelnetRecordStream(sink);
    stream.feed(Buffer.from([0x01, 0x02])); // record without terminator yet
    stream.reset();
    stream.feed(Buffer.from([0x03, IAC, EOR]));
    expect(records).toEqual([Buffer.from([0x03])]);
  });
});
