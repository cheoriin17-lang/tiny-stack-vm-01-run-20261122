// Tiny stack VM for make.fun bounty tiny-stack-vm-01-run-20261122 (ISA v1):
// 32-bit wrapping stack machine, 256-value data stack, 64-deep call stack,
// 256 words of memory, 1,000,000-step and 65,536-byte output limits, trap
// codes 2..11. One process answers the whole set: per /input/<id>/ it reads
// program.bin + input.bin and writes /output/<id>/stdout.bin + exit.txt.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STACK_MAX = 256;
const CALLS_MAX = 64;
const MEM_WORDS = 256;
const STEP_LIMIT = 1_000_000;
const OUT_MAX = 65_536;

// Opcode shapes, flat quads [op, immediate bytes, pops, pushes].
const IMM = new Uint8Array(256);
const POPS = new Uint8Array(256);
const PUSHES = new Uint8Array(256);
const KNOWN = new Uint8Array(256);
const OPS = [
  0x00,0,0,0, 0x01,1,0,1, 0x02,4,0,1, 0x03,0,1,0, 0x04,0,1,2,
  0x05,0,2,2, 0x06,0,2,3, 0x07,0,3,3, 0x10,0,2,1, 0x11,0,2,1,
  0x12,0,2,1, 0x13,0,2,1, 0x14,0,2,1, 0x15,0,2,1, 0x16,0,2,1,
  0x17,0,1,1, 0x18,0,2,1, 0x19,0,2,1, 0x1a,0,2,1, 0x1b,0,1,1,
  0x1c,0,2,1, 0x1d,0,2,1, 0x1e,0,2,1, 0x20,0,2,1, 0x21,0,2,1,
  0x22,0,2,1, 0x30,2,0,0, 0x31,2,1,0, 0x32,2,1,0, 0x33,2,0,0,
  0x34,0,0,0, 0x40,0,1,1, 0x41,0,2,0, 0x50,0,1,0, 0x51,0,1,0,
  0x52,0,0,1, 0x53,0,1,0,
];
for (let i = 0; i < OPS.length; i += 4) {
  const o = OPS[i];
  IMM[o] = OPS[i + 1];
  POPS[o] = OPS[i + 2];
  PUSHES[o] = OPS[i + 3];
  KNOWN[o] = 1;
}

// Runs one program to its end; returns [exit code, output length] with the
// program's bytes in `out` (only the first `len` bytes are valid).
function run(prog: Uint8Array, input: Uint8Array, out: Uint8Array): [number, number] {
  const n = prog.length;
  const st = new Int32Array(STACK_MAX);
  let sp = 0;
  const cs = new Int32Array(CALLS_MAX);
  let cp = 0;
  const mem = new Int32Array(MEM_WORDS);
  let olen = 0;
  let ipos = 0;
  let pc = 0;
  let steps = 0;

  for (;;) {
    if (steps === STEP_LIMIT) return [10, olen];
    if (pc < 0 || pc >= n) return [9, olen];
    const op = prog[pc];
    if (!KNOWN[op]) return [5, olen];
    const imm = IMM[op];
    if (pc + imm >= n) return [9, olen];
    steps++;
    const next = pc + 1 + imm;
    const pops = POPS[op];
    if (sp < pops) return [2, olen];
    if (sp - pops + PUSHES[op] > STACK_MAX) return [3, olen];
    pc = next;

    switch (op) {
      case 0x00: return [0, olen]; // HALT
      case 0x01: // PUSH8, sign-extended
        st[sp++] = (prog[next - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32, little-endian
        st[sp++] = prog[next - 4] | (prog[next - 3] << 8) | (prog[next - 2] << 16) | (prog[next - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: st[sp] = st[sp - 1]; sp++; break; // DUP
      case 0x05: { // SWAP
        const t = st[sp - 1];
        st[sp - 1] = st[sp - 2];
        st[sp - 2] = t;
        break;
      }
      case 0x06: st[sp] = st[sp - 2]; sp++; break; // OVER
      case 0x07: { // ROT (a b c -- b c a)
        const a = st[sp - 3];
        st[sp - 3] = st[sp - 2];
        st[sp - 2] = st[sp - 1];
        st[sp - 1] = a;
        break;
      }
      case 0x17: st[sp - 1] = -st[sp - 1] | 0; break; // NEG
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break; // NOT
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
      case 0x16: case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d:
      case 0x1e: case 0x20: case 0x21: case 0x22: {
        const b = st[sp - 1];
        const a = st[sp - 2];
        let r: number;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break;
          case 0x13: // DIV, truncated toward zero
            if (b === 0) return [4, olen];
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14: // MOD, sign of the dividend
            if (b === 0) return [4, olen];
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15: // DIVU
            if (b === 0) return [4, olen];
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16: // MODU
            if (b === 0) return [4, olen];
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;
          case 0x1d: r = a >> (b & 31); break;
          case 0x1e: r = (a >>> (b & 31)) | 0; break;
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        }
        sp -= 2;
        st[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((prog[next - 2] | (prog[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = st[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: // CALL
        if (cp === CALLS_MAX) return [7, olen];
        cs[cp++] = next;
        pc = prog[next - 2] | (prog[next - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return [8, olen];
        pc = cs[--cp];
        break;
      case 0x40: { // LOAD
        const addr = st[sp - 1];
        if (addr < 0 || addr >= MEM_WORDS) return [6, olen];
        st[sp - 1] = mem[addr];
        break;
      }
      case 0x41: { // STORE (v addr --)
        const addr = st[sp - 1];
        const v = st[sp - 2];
        if (addr < 0 || addr >= MEM_WORDS) return [6, olen];
        sp -= 2;
        mem[addr] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline
        const v = st[sp - 1];
        const s = String(v);
        if (olen + s.length > OUT_MAX) return [11, olen];
        sp--;
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC: low byte
        if (olen + 1 > OUT_MAX) return [11, olen];
        out[olen++] = st[--sp] & 255;
        break;
      case 0x52: // IN: next byte, -1 when exhausted
        st[sp++] = ipos < input.length ? input[ipos++] : -1;
        break;
      default: // EXIT: low byte of the popped value
        return [st[--sp] & 255, olen];
    }
  }
}

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const outBuf = new Uint8Array(OUT_MAX);

for (const id of readdirSync(IN_DIR).sort()) {
  const prog = readFileSync(join(IN_DIR, id, 'program.bin'));
  const input = readFileSync(join(IN_DIR, id, 'input.bin'));
  const [exit, len] = run(prog, input, outBuf);
  const dir = join(OUT_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout.bin'), outBuf.subarray(0, len));
  writeFileSync(join(dir, 'exit.txt'), String(exit) + '\n');
}
