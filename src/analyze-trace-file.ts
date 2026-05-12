// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Internal worker process spawned by analyze-trace-dir. Not a public CLI.
// Receives a single JSON payload describing what to analyze and prints the
// results to stdout (text or JSON, per the payload).

import exit = require("exit");

import { reportHighlights as reportText } from "./print-trace-analysis-text";
import { reportHighlights as reportJson } from "./print-trace-analysis-json";
import { TypeSource } from "./analyze-trace-utilities";

interface WorkerPayload {
    tracePath: string;
    typeSources?: TypeSource[];
    forceMillis: number;
    skipMillis: number;
    expandTypes: boolean;
    json: boolean;
    importExpressionThreshold: number;
    minPercentage: number;
}

run()
    .then(found => exit(found ? 0 : 1))
    .catch(err => {
        console.error(`Internal Error: ${err.message}\n${err.stack}`);
        exit(2);
    });

async function run(): Promise<boolean> {
    const payload = parsePayload(process.argv[2]);
    const reportHighlights = payload.json ? reportJson : reportText;
    const typeSources = payload.expandTypes ? payload.typeSources : undefined;
    return await reportHighlights(
        payload.tracePath,
        typeSources,
        payload.forceMillis * 1000,
        payload.skipMillis * 1000,
        payload.minPercentage,
        payload.importExpressionThreshold,
    );
}

function parsePayload(raw: string | undefined): WorkerPayload {
    if (!raw) {
        throw new Error("analyze-trace-file: missing JSON payload argument");
    }
    return JSON.parse(raw);
}
