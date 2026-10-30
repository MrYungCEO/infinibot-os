declare module "@lydell/node-pty" {
  export type PtyExitEvent = { exitCode: number; signal?: number };
  export type PtyListener<T> = (event: T) => void;
  export type PtyHandle = {
    pid: number;
    cols: number;
    rows: number;
    process: string;
    handleFlowControl: boolean;
    write: (data: string | Buffer) => void;
    resize: (cols: number, rows: number) => void;
    clear: () => void;
    kill: (signal?: string) => void;
    pause: () => void;
    resume: () => void;
    onData: (listener: PtyListener<string>) => { dispose: () => void };
    onExit: (listener: PtyListener<PtyExitEvent>) => { dispose: () => void };
  };

  export type IPty = PtyHandle;

  export type PtySpawn = (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding?: string | null;
    },
  ) => PtyHandle;

  export const spawn: PtySpawn;
}
