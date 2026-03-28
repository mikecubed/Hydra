/**
 * Promise-chain mutex — no external dependency.
 * Used to serialize config mutations so concurrent requests
 * observe consistent revision tokens.
 */

export interface MutexHandle {
  acquire(): Promise<() => void>;
}

function createMutex(): MutexHandle {
  let chain = Promise.resolve();
  return {
    acquire() {
      let release!: () => void;
      const lock = new Promise<void>((res) => {
        release = res;
      });
      const ticket = chain.then(() => release);
      chain = chain.then(() => lock);
      return ticket;
    },
  };
}

export const configMutex = createMutex();
