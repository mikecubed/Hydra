/**
 * Testable process exit handler.
 *
 * Replace direct process.exit() calls with exit() from this module so tests
 * can inject a spy via setExitHandler() without terminating the test process.
 */

// Handlers may return void in tests; exit() itself is declared never for call-site narrowing.
type ExitHandler = (code?: number) => void;

// eslint-disable-next-line n/no-process-exit -- this is the one place where process.exit() is intentionally called
let _exitHandler: ExitHandler = (code) => process.exit(code);

/** Inject a test spy. Call resetExitHandler() in afterEach. */
export function setExitHandler(handler: ExitHandler): void {
  _exitHandler = handler;
}

/** Restore the real process.exit() handler. */
export function resetExitHandler(): void {
  // eslint-disable-next-line n/no-process-exit -- this is the one place where process.exit() is intentionally called
  _exitHandler = (code) => process.exit(code);
}

/** Exit the process (or call the injected test handler). */
export function exit(code?: number): never {
  _exitHandler(code);
  // Unreachable in production (process.exit never returns).
  // Needed as a type-safe fallback for test handlers that return void.
  return undefined as never;
}
