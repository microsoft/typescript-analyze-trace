// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from "console";
import chalk = require("chalk");
import treeify = require("treeify");
import fs = require("fs");
import path = require("path");
import yargs = require("yargs");

import getTypeTree = require("./get-type-tree");
import normalizePositions = require("./normalize-positions");
import { commandLineOptions, checkCommandLineOptions } from "./analyze-trace-options";
import countImportExpressions = require("./count-import-expressions");

const argv = yargs(process.argv.slice(2))
    .command("$0 <tracePath> [typesPath]", "Preprocess tracing type dumps", yargs => yargs
        .positional("tracePath", { type: "string", desc: "Trace file to read", coerce: throwIfNotFile })
        .positional("typesPath", { type: "string", desc: "Corresponding types file", coerce: throwIfNotFile })
        .options(commandLineOptions)
        .check(checkCommandLineOptions)
        .help("h").alias("h", "help")
        .strict())
    .argv;

const Parser = require("jsonparse");

const tracePath = argv.tracePath!;
const typesPath = argv.typesPath;

const thresholdDuration = argv.forceMillis * 1000; // microseconds
const minDuration = argv.skipMillis * 1000; // microseconds
const minPercentage = 0.6;
const importExpressionThreshold = 10;

main().catch(err => console.error(`Internal Error: ${err.message}\n${err.stack}`));

type LineChar = normalizePositions.LineChar;
type PositionMap = Map<string, Map<string, LineChar>>; // Path to position (offset or LineChar) to LineChar

interface Event {
    ph: string;
    ts: string;
    dur?: string;
    name: string;
    cat: string;
    args?: any;
}

interface EventSpan {
    event?: Event;
    start: number;
    end: number;
    children: EventSpan[];
    typeTree?: any;
}

interface ParseResult {
    minTime: number;
    maxTime: number;
    spans: EventSpan[];
    unclosedStack: Event[];
}

function parse(tracePath: string): Promise<ParseResult> {
    return new Promise<ParseResult>(resolve => {
        const p = new Parser();

        let minTime = Infinity;
        let maxTime = 0;
        const unclosedStack: Event[] = []; // Sorted in increasing order of start time (even when below timestamp resolution)
        const spans: EventSpan[] = []; // Sorted in increasing order of end time, then increasing order of start time (even when below timestamp resolution)
        p.onValue = function (value: any) {
            if (this.stack.length !== 1) return;
            assert(this.mode === Parser.C.ARRAY, `Unexpected mode ${this.mode}`);
            this.value = [];

            // Metadata objects are uninteresting
            if (value.ph === "M") return;

            // TODO (https://github.com/microsoft/typescript-analyze-trace/issues/1)
            if (value.ph === "i" || value.ph === "I") return;

            const event = value as Event;

            if (event.ph === "B") {
                unclosedStack.push(event);
                return;
            }

            let span: EventSpan;
            if (event.ph === "E") {
                const beginEvent = unclosedStack.pop()!;
                span = { event: beginEvent, start: +beginEvent.ts, end: +event.ts, children: [] };
            }
            else if (event.ph === "X") {
                const start = +event.ts;
                const duration = +event.dur!;
                span = { event, start, end: start + duration, children: [] }
            }
            else {
                assert(false, `Unknown event phase ${event.ph}`);
                return;
            }

            minTime = Math.min(minTime, span.start);
            maxTime = Math.max(maxTime, span.end);

            if ((span.end - span.start) >= minDuration) {
                spans.push(span);
            }
        }

        const readStream = fs.createReadStream(tracePath);
        readStream.on("data", chunk => p.write(chunk));
        readStream.on("end", () => {
            resolve({
                minTime,
                maxTime,
                spans: spans,
                unclosedStack: unclosedStack,
            });
        });
    });
}

async function main(): Promise<void> {
    const { minTime, maxTime, spans, unclosedStack } = await parse(tracePath);

    if (unclosedStack.length) {
        console.log("Trace ended unexpectedly");

        while (unclosedStack.length) {
            const event = unclosedStack.pop()!;
            console.log(`> ${event.name}: ${JSON.stringify(event.args)}`);
            spans.push({ event, start: +event.ts, end: maxTime, children: [] });
        }

        console.log();
    }

    spans.sort((a, b) => a.start - b.start);

    const root: EventSpan = { start: minTime, end: maxTime, children: [] };
    const stack = [ root ];

    for (const span of spans) {
        let i = stack.length - 1;
        for (; i > 0; i--) { // No need to check root at stack[0]
            const curr = stack[i];
            if (curr.end > span.start) {
                // Pop down to parent
                stack.length = i + 1;
                break;
            }
        }

        const parent = stack[i];
        const duration = span.end - span.start;
        if (duration >= thresholdDuration || duration >= minPercentage * (parent.end - parent.start)) {
            parent.children.push(span);
            stack.push(span);
        }
    }

    await printHotStacks(root);
}

async function printHotStacks(root: EventSpan): Promise<void> {
    if (typesPath) {
        await addTypeTrees(root);
    }
    const positionMap = await getNormalizedPositions(root);
    const tree = await makePrintableTree(root, /*currentFile*/ undefined, positionMap);
    if (Object.entries(tree).length) {
        console.log("Hot Spots");
        console.log(treeify.asTree(tree, /*showValues*/ false, /*hideFunctions*/ true));
    }
    else {
        console.log("No hot spots found")
    }
}

async function addTypeTrees(root: EventSpan): Promise<void> {
    const stack: EventSpan[] = [];
    stack.push(root);

    while(stack.length) {
        const curr = stack.pop()!;
        if (curr.children.length === 0) {
            if (curr.event?.name === "structuredTypeRelatedTo") {
                const types = await getTypes();
                if (types.length) {
                    curr.typeTree = {
                        ...getTypeTree(types, curr.event.args!.sourceId),
                        ...getTypeTree(types, curr.event.args!.targetId),
                    };
                }
            }
            else if (curr.event?.name === "getVariancesWorker") {
                const types = await getTypes();
                if (types.length) {
                    curr.typeTree = getTypeTree(types, curr.event.args!.id);
                }
            }
        }

        stack.push(...curr.children); // Order doesn't matter during this traversal
    }
}

async function getNormalizedPositions(root: EventSpan): Promise<PositionMap> {
    const positionMap = new Map<string, (number | LineChar)[]>();
    recordPositions(root, /*currentFile*/ undefined);

    const map = new Map<string, Map<string, LineChar>>(); // NB: can't use LineChar as map key
    for (const entry of Array.from(positionMap.entries())) {
        try {
            const path = entry[0];
            const sourceStream = fs.createReadStream(path, { encoding: "utf-8" });

            const rawPositions = entry[1];
            const normalizedPositions = await normalizePositions(sourceStream, rawPositions);

            const pathMap = new Map<string, LineChar>();
            for (let i = 0; i < rawPositions.length; i++) {
                const rawPosition = rawPositions[i];
                const key = typeof rawPosition === "number" ? Math.abs(rawPosition).toString() : getLineCharMapKey(...rawPosition as LineChar);
                pathMap.set(key, normalizedPositions[i]);
            }

            map.set(path, pathMap);
        } catch {
            // Not finding a file is expected if this isn't the box on which the trace was recorded.
        }
    }

    return map;

    function recordPositions(span: EventSpan, currentFile: string | undefined): void {
        if (span.event?.name === "checkSourceFile") {
            currentFile = span.event!.args!.path;
        }
        else if (span.event?.cat === "check") {
            const args = span.event.args;
            currentFile = args?.path ?? currentFile;
            if (currentFile) {
                if (args?.pos) {
                    recordPosition(currentFile, args.pos);
                }
                if (args?.end) {
                    recordPosition(currentFile, -args.end); // Negative since end should not be moved past trivia
                }
            }
        }

        for (const child of span.children) {
            recordPositions(child, currentFile);
        }

        recordPositionsInTypeTree(span.typeTree);
    }

    function recordPositionsInTypeTree(typeTree: any): void {
        if (!typeTree) return;

        for (const typeString in typeTree) {
            const type = JSON.parse(typeString);
            if (type.location) {
                const location = type.location;
                recordPosition(location.path, [ location.line, location.char ]);
            }

            recordPositionsInTypeTree(typeTree[typeString]);
        }
    }

    function recordPosition(path: string, position: number | LineChar): void {
        if (!positionMap.has(path)) {
            positionMap.set(path, []);
        }

        positionMap.get(path)!.push(position);
    }
}

let typesCache: undefined | readonly any[];
async function getTypes(): Promise<readonly any[]> {
    if (!typesCache) {
        try {
            const json = await fs.promises.readFile(typesPath!, { encoding: "utf-8" });
            typesCache = JSON.parse(json);
        }
        catch (e: any) {
            console.error(`Error reading types file: ${e.message}`);
            typesCache = [];
        }
    }

    return typesCache!;
}

async function makePrintableTree(curr: EventSpan, currentFile: string | undefined, positionMap: PositionMap): Promise<{}> {
    // Sort slow to fast
    let childTree = {};

    let showCurrentFile = false;
    if (curr.event?.cat === "check") {
        const path = curr.event.args!.path;
        if (path) {
            showCurrentFile = path !== currentFile;
            currentFile = path;
        }
        else {
            assert(curr.event?.name !== "checkSourceFile", "checkSourceFile should have a path");
        }
    }

    if (curr.children.length) {
        const sortedChildren = curr.children.sort((a, b) => (b.end - b.start) - (a.end - a.start));
        for (const child of sortedChildren) {
            Object.assign(childTree, await makePrintableTree(child, currentFile, positionMap));
        }
    }

    if (curr.typeTree) {
        Object.assign(childTree, updateTypeTreePositions(curr.typeTree));
    }

    if (curr.event) {
        const eventStr = await eventToString();
        if (eventStr) {
            let result = {};
            result[`${eventStr} (${Math.round((curr.end - curr.start) / 1000)}ms)`] = childTree;
            return result;
        }
    }

    return childTree;

    async function eventToString(): Promise<string | undefined> {
        const event = curr.event!;
        switch (event.name) {
            // TODO (https://github.com/microsoft/typescript-analyze-trace/issues/2)
            // case "findSourceFile":
            //     return `Load file ${event.args!.fileName}`;
            case "emitDeclarationFileOrBundle":
                const dtsPath = event.args.declarationFilePath;
                if (!dtsPath || !fs.existsSync(dtsPath)) {
                    return undefined;
                }
                try {
                    const sourceStream = fs.createReadStream(dtsPath, { encoding: "utf-8" });
                    const frequency = await countImportExpressions(sourceStream);
                    const sorted = Array.from(frequency.entries()).sort(([import1, count1], [import2, count2]) => count2 - count1 || import1.localeCompare(import2)).filter(([_, count]) => count >= importExpressionThreshold);
                    if (sorted.length === 0) {
                        return undefined;
                    }
                    for (const [imp, count] of sorted) {
                        // Directly modifying childTree is pretty hacky
                        childTree[`Consider adding \`${chalk.cyan(`import ${chalk.cyan(imp)}`)}\` which is used in ${count} places`] = {};
                    }
                    return `Emit typings file ${formatPath(dtsPath)}`;
                }
                catch {
                    return undefined;
                }
            case "checkSourceFile":
                return `Check file ${formatPath(currentFile!)}`;
            case "structuredTypeRelatedTo":
                const args = event.args!;
                return `Compare types ${args.sourceId} and ${args.targetId}`;
            case "getVariancesWorker":
                return `Determine variance of type ${event.args!.id}`;
            default:
                if (event.cat === "check" && event.args && event.args.pos && event.args.end) {
                    const currentFileClause = showCurrentFile
                        ? ` in ${formatPath(currentFile!)}`
                        : "";
                    if (positionMap.has(currentFile!)) {
                        const updatedPos = positionMap.get(currentFile!)!.get(event.args.pos.toString())!;
                        const updatedEnd = positionMap.get(currentFile!)!.get(event.args.end.toString())!;
                        return `${unmangleCamelCase(event.name)}${currentFileClause} from (line ${updatedPos[0]}, char ${updatedPos[1]}) to (line ${updatedEnd[0]}, char ${updatedEnd[1]})`;
                    }
                    else {
                        return `${unmangleCamelCase(event.name)}${currentFileClause} from offset ${event.args.pos} to offset ${event.args.end}`;
                    }
                }
                return undefined;
        }
    }

    function updateTypeTreePositions(typeTree: any): any {
        if (!typeTree) return;

        let newTree = {};
        for (let typeString in typeTree) {
            const subtree = typeTree[typeString];

            const type = JSON.parse(typeString);
            if (type.location) {
                const path = type.location.path;
                if (positionMap.has(path)) {
                    const updatedPosition = positionMap.get(path)!.get(getLineCharMapKey(type.location.line, type.location.char))!;
                    [ type.location.line, type.location.char ] = updatedPosition;

                    typeString = JSON.stringify(type);
                }

                typeString = typeString.replace(path, formatPath(path));
            }

            newTree[typeString] = updateTypeTreePositions(subtree);
        }

        return newTree;
    }
}

function formatPath(p: string) {
    if (/node_modules/.test(p)) {
        p = p.replace(/\/node_modules\/([^@][^/]+)\//g, `/node_modules/${chalk.cyan("$1")}/`);
        p = p.replace(/\/node_modules\/(@[^/]+\/[^/]+)/g, `/node_modules/${chalk.cyan("$1")}/`);
    }
    else {
        p = path.join(path.dirname(p), chalk.cyan(path.basename(p)));
    }
    return chalk.magenta(path.normalize(p));
}

function unmangleCamelCase(name: string) {
    let result = "";
    for (const char of [...name]) {
        if (!result.length) {
            result += char.toLocaleUpperCase();
            continue;
        }

        const lower = char.toLocaleLowerCase();
        if (char !== lower) {
            result += " ";
        }

        result += lower;
    }
    return result;
}

function getLineCharMapKey(line: number, char: number) {
    return `${line},${char}`;
}

function throwIfNotFile(path: string): string {
    if (!fs.existsSync(path) || !fs.statSync(path)?.isFile()) {
        throw new Error(`${path} is not a file`);
    }
    return path;
}