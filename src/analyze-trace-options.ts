// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const commandLineOptions = {
    "forceMillis": {
        alias: ["forcemillis", "force-millis"],
        describe: "Events of at least this duration (in milliseconds) will reported unconditionally",
        type: "number",
        default: 500,
    },
    "skipMillis": {
        alias: ["skipmillis", "skip-millis"],
        describe: "Events of less than this duration (in milliseconds) will suppressed unconditionally",
        type: "number",
        default: 100,
    },
} as const;

// Replicating the type inference in yargs would be excessive
type Argv = {
    forceMillis: number,
    skipMillis: number
};

export function checkCommandLineOptions(argv: Argv): true {
    if (argv.forceMillis < argv.skipMillis) {
        throw new Error("forceMillis cannot be less than skipMillis")
    }
    return true;
}