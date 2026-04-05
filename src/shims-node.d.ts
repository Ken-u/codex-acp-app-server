declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }

  interface Process {
    stdin: import("node:stream").Readable;
    stdout: import("node:stream").Writable;
    stderr: import("node:stream").Writable;
    env: ProcessEnv;
    cwd(): string;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    exit(code?: number): never;
  }

  interface ErrnoException extends Error {
    code?: string;
  }
}

declare const process: NodeJS.Process;

declare class Buffer {
  toString(): string;
}

declare function setTimeout(
  callback: (...args: any[]) => void,
  ms?: number
): { unref?: () => void };

declare module "node:events" {
  class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }

  export { EventEmitter };
}

declare module "node:stream" {
  class Readable {
    on(event: string, listener: (...args: any[]) => void): this;
  }

  class Writable {
    writable: boolean;
    write(chunk: string): boolean;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export { Readable, Writable };
}

declare module "node:child_process" {
  import type { EventEmitter } from "node:events";
  import type { Readable, Writable } from "node:stream";

  interface ChildProcessWithoutNullStreams extends EventEmitter {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    killed: boolean;
    kill(): boolean;
  }

  type SpawnOptionsWithoutStdio = {
    cwd?: string;
    stdio?: ["pipe", "pipe", "pipe"];
  };

  function spawn(
    command: string,
    args?: string[],
    options?: SpawnOptionsWithoutStdio
  ): ChildProcessWithoutNullStreams;

  export { spawn };
  export type { ChildProcessWithoutNullStreams };
}

declare module "node:readline" {
  import type { Readable } from "node:stream";
  import type { EventEmitter } from "node:events";

  type Interface = EventEmitter;

  function createInterface(options: {
    input: Readable;
    crlfDelay?: number;
    terminal?: boolean;
  }): Interface;

  export { createInterface };
}
