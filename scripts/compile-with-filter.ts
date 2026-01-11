import { spawn } from 'child_process';

type WarningFilterState = {
  buffer: string;
  pendingWarningLines: string[] | null; // holds lines until we decide whether to filter
  skippingKnownWarning: boolean;
  skippingSawCaret: boolean;
};

const OZ_REENTRANCY_SIG = '@openzeppelin/contracts/security/ReentrancyGuard.sol:53:9:';
const OZ_REENTRANCY_UPG_SIG =
  '@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol:58:9:';

function createWarningFilterWriter(writeLine: (lineWithNewline: string) => void) {
  const state: WarningFilterState = {
    buffer: '',
    pendingWarningLines: null,
    skippingKnownWarning: false,
    skippingSawCaret: false,
  };

  let filteredCount = 0;

  const flushPending = () => {
    if (!state.pendingWarningLines) return;
    for (const l of state.pendingWarningLines) writeLine(l);
    state.pendingWarningLines = null;
  };

  const handleLine = (rawLine: string) => {
    // Normalize Windows CRLF in case.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const withNewline = `${line}\n`;

    // If we're currently skipping a known OZ warning block, drop lines until:
    // - we see the caret line (contains '^'), then
    // - we drop subsequent blank lines,
    // - and stop skipping when we hit the first non-blank line after that.
    if (state.skippingKnownWarning) {
      if (!state.skippingSawCaret) {
        if (line.includes('^')) state.skippingSawCaret = true;
        return;
      }

      if (line.trim() === '') return;

      // First non-empty line after the warning block: stop skipping and process it normally.
      state.skippingKnownWarning = false;
      state.skippingSawCaret = false;
      // fallthrough to normal processing for this line
    }

    // If we saw "Warning: Unreachable code." we hold the next line to decide.
    if (state.pendingWarningLines) {
      state.pendingWarningLines.push(withNewline);

      if (state.pendingWarningLines.length === 2) {
        const arrowLine = state.pendingWarningLines[1];
        const isKnown =
          arrowLine.includes(OZ_REENTRANCY_SIG) || arrowLine.includes(OZ_REENTRANCY_UPG_SIG);

        if (isKnown) {
          // Drop the warning header + arrow line, then skip the rest of this warning block.
          state.pendingWarningLines = null;
          state.skippingKnownWarning = true;
          state.skippingSawCaret = false;
          filteredCount += 1;
          return;
        }

        // Not one of the known OZ warnings → flush immediately to preserve output.
        flushPending();
        return;
      }

      // Still waiting for the second line.
      return;
    }

    if (line.startsWith('Warning: Unreachable code.')) {
      state.pendingWarningLines = [withNewline];
      return;
    }

    writeLine(withNewline);
  };

  const writeChunk = (chunk: Buffer | string) => {
    state.buffer += chunk.toString();
    while (true) {
      const idx = state.buffer.indexOf('\n');
      if (idx === -1) break;
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);
      handleLine(line);
    }
  };

  const end = () => {
    // Flush any remaining buffered content as a final line.
    if (state.buffer.length > 0) {
      handleLine(state.buffer);
      state.buffer = '';
    }
    // If we were holding a warning line but never got the arrow line, flush it.
    flushPending();
  };

  return {
    writeChunk,
    end,
    getFilteredCount: () => filteredCount,
  };
}

async function main() {
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = ['-s', 'exec', 'hardhat', 'compile'];

  const child = spawn(pnpmCmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
  });

  const outFilter = createWarningFilterWriter((l) => process.stdout.write(l));
  const errFilter = createWarningFilterWriter((l) => process.stderr.write(l));

  child.stdout?.on('data', (d) => outFilter.writeChunk(d));
  child.stderr?.on('data', (d) => errFilter.writeChunk(d));

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });

  outFilter.end();
  errFilter.end();

  const filtered = outFilter.getFilteredCount() + errFilter.getFilteredCount();
  if (filtered > 0) {
    process.stderr.write(
      `Filtered ${filtered} known viaIR warning(s): OZ ReentrancyGuard unreachable code.\n`
    );
  }

  process.exit(exitCode);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();

