// Type declarations for @lydell/node-pty-win32-x64
declare module "@lydell/node-pty-win32-x64" {
    export interface IPty {
        pid: number;
        cols: number;
        rows: number;
        process: string;
        handleFlowControl: boolean;

        onData(callback: (data: string) => void): void;
        onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;

        write(data: string): void;
        resize(cols: number, rows: number): void;
        clear(): void;
        kill(signal?: string): void;
        pause(): void;
        resume(): void;
    }

    export interface IWindowsPtyForkOptions {
        name?: string;
        cols?: number;
        rows?: number;
        cwd?: string;
        env?: { [key: string]: string };
        encoding?: string;
        useConpty?: boolean;
        conptyInheritCursor?: boolean;
    }

    export function spawn(
        file: string,
        args: string[],
        options: IWindowsPtyForkOptions
    ): IPty;
}
