// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs = require("fs");
import path = require("path");
import countImportExpressions = require("./count-import-expressions");
import normalizePositions = require("./normalize-positions");
import simplify = require("./simplify-type");
import { Event, EventSpan, ParseResult } from "./parse-trace-file";

import jsonstream = require("jsonstream-next");

export function buildHotPathsTree(parseResult: ParseResult, thresholdDuration: number, minPercentage: number): EventSpan {
    const { minTime, maxTime, spans, unclosedStack } = parseResult;

    for (let i = unclosedStack.length - 1; i >= 0; i--) {
        const event = unclosedStack[i];
        spans.push({ event, start: +event.ts, end: maxTime, children: [] });
    }

    spans.sort((a, b) => a.start - b.start || b.end - a.end);

    const root: EventSpan = { start: minTime, end: maxTime, children: [] };
    const stacks = new Map<string, EventSpan[]>();

    for (const span of spans) {
        const stack = getStack(span);
        let i = stack.length - 1;
        for (; i > 0; i--) { // No need to check root at stack[0]
            const curr = stack[i];
            if (contains(curr, span)) {
                break;
            }
        }

        // Pop down to parent, or to the root if this is a sibling of the whole lane.
        stack.length = i + 1;
        const parent = stack[i];
        const duration = span.end - span.start;
        if (duration >= thresholdDuration || duration >= minPercentage * (parent.end - parent.start)) {
            parent.children.push(span);
            stack.push(span);
        }
    }

    return root;

    function getStack(span: EventSpan): EventSpan[] {
        const event = span.event;
        const key = `${event?.pid ?? 1}:${event?.tid ?? 1}`;
        let stack = stacks.get(key);
        if (!stack) {
            stack = [ root ];
            stacks.set(key, stack);
        }
        return stack;
    }

    function contains(parent: EventSpan, child: EventSpan): boolean {
        return parent.start <= child.start && child.end <= parent.end;
    }
}

type LineChar = normalizePositions.LineChar;
export type PositionMap = Map<string, Map<string, LineChar>>; // Path to position (offset or LineChar) to LineChar

export async function getNormalizedPositions(root: EventSpan, relatedTypes: readonly Map<number, object>[] | undefined): Promise<PositionMap> {
    const positionMap = new Map<string, (number | LineChar)[]>();
    recordPositions(root, /*currentFile*/ undefined);
    if (relatedTypes) {
        for (const relatedTypesForSource of relatedTypes) {
            for (const type of relatedTypesForSource.values()) {
                const location: any = (type as any).location;
                if (location) {
                    recordPosition(location.path, [ location.line, location.char ]);
                }
            }
        }
    }

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
            currentFile = span.event.args?.path ?? currentFile;
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
    }

    function recordPosition(path: string, position: number | LineChar): void {
        if (!positionMap.has(path)) {
            positionMap.set(path, []);
        }

        positionMap.get(path)!.push(position);
    }
}

export function getLineCharMapKey(line: number, char: number) {
    return `${line},${char}`;
}

export interface TypeSource {
    typesPath: string;
    checkerId?: number;
}

export type TypeSources = readonly TypeSource[];

export const typeSourcesEnvVar = "TYPESCRIPT_ANALYZE_TRACE_TYPE_SOURCES";

export async function getPackageVersion(packagePath: string): Promise<string | undefined> {
    try {
        const jsonPath = path.join(packagePath, "package.json");
        const jsonString = await fs.promises.readFile(jsonPath, { encoding: "utf-8" });
        const jsonObj = JSON.parse(jsonString);
        return jsonObj.version;
    }
    catch {
    }

    return undefined;
}

export function unmangleCamelCase(name: string) {
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

const typesCache = new Map<string, Promise<readonly any[]>>();
export async function getTypes(typesPath: string): Promise<readonly any[]> {
    let typesPromise = typesCache.get(typesPath);
    if (!typesPromise) {
        typesPromise = new Promise((resolve, _reject) => {
            const types: any[] = [];

            const readStream = fs.createReadStream(typesPath, { encoding: "utf-8" });
            readStream.on("end", () => {
                resolve(types);
            });
            readStream.on("error", onError);

            // expects types file to be {object[]}
            const parser = jsonstream.parse("*");
            parser.on("data", (data: object) => {
                types.push(data);
            });
            parser.on("error", onError);

            readStream.pipe(parser);

            function onError(e: Error) {
                console.error(`Error reading types file: ${e.message}`);
                resolve(types);
            }
        });
        typesCache.set(typesPath, typesPromise);
    }

    return typesPromise;
}

export interface EmittedImport {
    name: string;
    count: number;
}

export async function getEmittedImports(dtsPath: string, importExpressionThreshold: number): Promise<EmittedImport[]> {
    const sourceStream = fs.createReadStream(dtsPath, { encoding: "utf-8" });
    const frequency = await countImportExpressions(sourceStream);
    const sorted = Array.from(frequency.entries())
        .sort(([import1, count1], [import2, count2]) => count2 - count1 || import1.localeCompare(import2))
        .filter(([_, count]) => count >= importExpressionThreshold)
        .map(([name, count]) => ({ name, count }));
    return sorted;
}

export type RelatedTypes = Map<string, Map<number, object>>;

export async function getRelatedTypes(root: EventSpan, typeSources: TypeSources, leafOnly: boolean): Promise<RelatedTypes> {
    const relatedTypes = new Map<string, Map<number, object>>();

    const stack: EventSpan[] = [];
    stack.push(root);

    while(stack.length) {
        const curr = stack.pop()!;
        if (!leafOnly || curr.children.length === 0) {
            if (curr.event?.name === "structuredTypeRelatedTo") {
                const args = curr.event.args;
                if (!args) {
                    stack.push(...curr.children);
                    continue;
                }
                const typeSource = getTypeSourceForEvent(typeSources, curr.event);
                if (!typeSource) {
                    stack.push(...curr.children);
                    continue;
                }
                const types = await getTypes(typeSource.typesPath);
                if (types.length) {
                    const relatedTypesForSource = getRelatedTypesForSource(relatedTypes, typeSource);
                    addRelatedTypes(types, args.sourceId, relatedTypesForSource);
                    addRelatedTypes(types, args.targetId, relatedTypesForSource);
                }
            }
            else if (curr.event?.name === "getVariancesWorker") {
                const args = curr.event.args;
                if (!args) {
                    stack.push(...curr.children);
                    continue;
                }
                const typeSource = getTypeSourceForEvent(typeSources, curr.event);
                if (!typeSource) {
                    stack.push(...curr.children);
                    continue;
                }
                const types = await getTypes(typeSource.typesPath);
                if (types.length) {
                    const relatedTypesForSource = getRelatedTypesForSource(relatedTypes, typeSource);
                    addRelatedTypes(types, args.id, relatedTypesForSource);
                }
            }
        }

        stack.push(...curr.children); // Order doesn't matter during this traversal
    }

    return relatedTypes;
}

export function getRelatedTypesForEvent(relatedTypes: RelatedTypes | undefined, typeSources: TypeSources | undefined, event: Event): Map<number, object> | undefined {
    if (!relatedTypes || !typeSources) {
        return undefined;
    }

    const typeSource = getTypeSourceForEvent(typeSources, event);
    return typeSource && relatedTypes.get(getTypeSourceKey(typeSource));
}

export function getAllRelatedTypes(relatedTypes: RelatedTypes | undefined): Map<number, object>[] | undefined {
    return relatedTypes && Array.from(relatedTypes.values());
}

function getRelatedTypesForSource(relatedTypes: RelatedTypes, typeSource: TypeSource): Map<number, object> {
    const key = getTypeSourceKey(typeSource);
    let relatedTypesForSource = relatedTypes.get(key);
    if (!relatedTypesForSource) {
        relatedTypesForSource = new Map<number, object>();
        relatedTypes.set(key, relatedTypesForSource);
    }
    return relatedTypesForSource;
}

function getTypeSourceForEvent(typeSources: TypeSources, event: Event): TypeSource | undefined {
    if (typeSources.length === 1) {
        return typeSources[0];
    }

    const checkerId = event.args?.checkerId;
    if (checkerId === undefined) {
        return undefined;
    }

    return typeSources.find(typeSource => typeSource.checkerId === checkerId);
}

function getTypeSourceKey(typeSource: TypeSource): string {
    return typeSource.checkerId === undefined ? typeSource.typesPath : `${typeSource.checkerId}`;
}

function addRelatedTypes(types: readonly object[], id: number, relatedTypes: Map<number, object>): void {
    worker(id);

    function worker(id: any): void {
        if (typeof id !== "number") return;
        const type: any = types[id - 1];
        if (!type) return;

        // If there's a cycle, suppress the children, but not the type itself
        if (!relatedTypes.has(id)) {
            relatedTypes.set(id, simplify(type));

            for (const prop in type) {
                if (prop.match(/type/i)) {
                    if (Array.isArray(type[prop])) {
                        for (const t of type[prop]) {
                            worker(t);
                        }
                    }
                    else {
                        worker(type[prop]);
                    }
                }
            }
        }
    }
}
