declare module 'parse-diff' {
    export interface Change {
        type: string;
        content: string;
        ln?: number;
        ln2?: number;
        normal?: boolean;
        add?: boolean;
        del?: boolean;
    }

    export interface Chunk {
        content: string;
        changes: Change[];
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
    }

    export interface File {
        chunks: Chunk[];
        deletions: number;
        additions: number;
        from: string;
        to: string;
        index: string[];
        binary?: boolean;
        new?: boolean;
        deleted?: boolean;
    }

    export default function parseDiff(diff: string): File[];
}
