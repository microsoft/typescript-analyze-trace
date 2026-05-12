// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import cp = require("child_process");
import fs = require("fs");
import os = require("os");
import path = require("path");

import exit = require("exit");
import plimit = require("p-limit");
import yargs = require("yargs");

import { TypeSource } from "./analyze-trace-utilities";
import { commandLineOptions, checkCommandLineOptions } from "./analyze-trace-options";

// Mirror of the worker's defaults; kept here so the dir analyzer is the single source of truth
// for what gets handed to each worker invocation.
const minPercentage = 0.6;
const importExpressionThreshold = 10;

const argv = yargs(process.argv.slice(2))
    .command("$0 <traceDir>", "Preprocess tracing type dumps", yargs => yargs
        .positional("traceDir", { type: "string", desc: "Directory of trace and types files", coerce: throwIfNotDirectory })
        .options(commandLineOptions)
        .check(checkCommandLineOptions)
        .help("h").alias("h", "help")
        .epilog("Exits with code 0 if highlights were found, 1 if no highlights were found, and 2 if an error occurred")
        .strict())
    .argv;

// Try to leave one core free
const limit = plimit(Math.max(1, os.cpus().length - 1));

const traceDir = argv.traceDir!;

main()
    .then(code => exit(code))
    .catch(err => {
        console.error(`Internal Error: ${err.message}`)
        exit(2);
    });

interface Project {
    configFilePath?: string;
    tracePath: string;
    typeSources?: TypeSource[];
}

interface LegendProject extends Project {
    typesPath?: string;
    checkerId?: number;
}

interface ProjectResult {
    project: Project;
    stdout: string;
    stderr: string;
    exitCode: number | undefined;
    signal: NodeJS.Signals | undefined;
}

interface SerializableProject {
    configFilePath?: string;
    tracePath: string;
    typesPath?: string;
    typesPaths?: string[];
    typeSources?: TypeSource[];
}

async function main(): Promise<number> {
    let projects: undefined | Project[];

    const legendPath = path.join(traceDir, "legend.json");
    if (await isFile(legendPath)) {
        try {
            const legendText = await fs.promises.readFile(legendPath, { encoding: "utf-8" });
            projects = coalesceProjectsFromLegend(JSON.parse(legendText));
        }
        catch (e: any) {
            console.error(`Error reading legend file: ${e.message}`);
        }
    }

    if (!projects) {
        projects = [];

        for (const entry of await fs.promises.readdir(traceDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;

            const name = entry.name;
            const match = name.match(/^trace(.*\.json)$/);
            if (match) {
                projects.push({
                    tracePath: path.join(traceDir, name),
                    typeSources: [{ typesPath: path.join(traceDir, `types${match[1]}`) }],
                });
            }
        }
    }

    const results = await Promise.all(projects.map(p => limit(analyzeProject, p)));
    return argv.json
        ? await printResultsAsJson(results)
        : await printResultsAsText(results);
}

async function printResultsAsJson(results: readonly ProjectResult[]): Promise<number> {
    let sawHighlights = false;
    const hadErrors: ProjectResult[] = [];
    const hadNoErrors: (ProjectResult & { highlights: object })[] = [];
    for (const result of results) {
        if (result.stderr || result.signal) {
            hadErrors.push(result);
            continue;
        }

        if (result.exitCode) {
            // 1 just indicates "no highlights"
            if (result.exitCode !== 1) {
                hadErrors.push(result);
            }
            continue;
        }

        try {
            hadNoErrors.push({ ...result, highlights: JSON.parse(result.stdout) });
            sawHighlights = true;
        }
        catch {
            hadErrors.push({ ...result, stderr: "Failed to parse project result JSON" });
        }
    }

    const json = {
        errors: hadErrors.length === 0
            ? undefined
            : hadErrors.map(result => ({
                ...result,
                project: serializeProject(result.project),
                stdout: undefined,
                stderr: undefined,
                exitCode: result.exitCode || undefined,
                message: result.stderr,
            })),
        results: hadNoErrors.map(result => ({
            project: serializeProject(result.project),
            highlights: result.highlights,
        })),
    };

    console.log(JSON.stringify(json, undefined, 2));

    return hadErrors.length > 0
        ? 2
        : sawHighlights
            ? 0
            : 1;
}

async function printResultsAsText(results: readonly ProjectResult[]): Promise<number> {
    const hadHighlights: (ProjectResult & { score: number })[] = [];
    const hadErrors: ProjectResult[] = [];
    for (const result of results) {
        if (result.stderr || result.signal) {
            hadErrors.push(result);
            continue;
        }

        if (result.exitCode) {
            // 1 just indicates "no highlights"
            if (result.exitCode !== 1) {
                hadErrors.push(result);
            }
            continue;
        }

        // First will be the largest, so only need to match one
        const match = result.stdout.match(/\((\d+)[ ]*ms\)/);
        const score = match ? +match[1] : 0; // Treat all duplicates as tied for now
        hadHighlights.push({...result, score });
    }

    let first = true;
    const projectCount = results.length;

    // Break ties with trace paths for determinism
    hadHighlights.sort((a, b) => b.score - a.score || a.project.tracePath.localeCompare(b.project.tracePath) ); // Descending
    for (const result of hadHighlights) {
        if (!first) console.log();
        first = false;

        const project = result.project;
        if (projectCount > 1 || project.configFilePath) {
            console.log(`Analyzed ${getProjectDescription(project)}`);
        }
        console.log(result.stdout);
    }

    for (const errorResult of hadErrors) {
        if (!first) console.log();
        first = false;

        const project = errorResult.project;
        console.log(`Error analyzing ${getProjectDescription(project)}`);
        if (errorResult.stderr) {
            console.log(errorResult.stderr);
        }
        else if (errorResult.exitCode) {
            console.log(`Exited with code ${errorResult.exitCode}`);
        }
        else if (errorResult.signal) {
            console.log(`Terminated with signal ${errorResult.signal}`);
        }
    }

    const interestingCount = hadHighlights.length + hadErrors.length;
    if (interestingCount < projectCount) {
        if (!first) console.log();
        first = false;

        console.log(`Found nothing in ${projectCount - interestingCount}${interestingCount ? " other" : ""} project(s)`);
    }

    return hadErrors.length > 0
        ? 2
        : hadHighlights.length > 0
            ? 0
            : 1;
}

function getProjectDescription(project: Project) {
    return project.configFilePath
       ? `${project.configFilePath} (${path.basename(project.tracePath)})`
       : path.basename(project.tracePath);
}

function serializeProject(project: Project): SerializableProject {
    const typesPaths = project.typeSources?.map(source => source.typesPath);
    return {
        configFilePath: project.configFilePath,
        tracePath: project.tracePath,
        typesPath: typesPaths?.length === 1 ? typesPaths[0] : undefined,
        typesPaths: typesPaths && typesPaths.length > 1 ? typesPaths : undefined,
        typeSources: project.typeSources,
    };
}

async function analyzeProject(project: Project): Promise<ProjectResult> {
    const typeSources = await getExistingTypeSources(project);
    const payload = {
        tracePath: project.tracePath,
        typeSources,
        forceMillis: argv.forceMillis,
        skipMillis: argv.skipMillis,
        expandTypes: argv.expandTypes,
        json: argv.json,
        minPercentage,
        importExpressionThreshold,
    };

    return new Promise<ProjectResult>(resolve => {
        const child = cp.fork(path.join(__dirname, "analyze-trace-file"), [JSON.stringify(payload)], {
            stdio: "pipe",
        });

        let stdout = "";
        let stderr = "";

        child.stdout!.on("data", chunk => stdout += chunk);
        child.stderr!.on("data", chunk => stderr += chunk);

        child.on("exit", (code, signal) => {
            resolve({
                project,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: code ?? undefined,
                signal: signal ?? undefined,
            });
        });
    });
}

async function getExistingTypeSources(project: Project): Promise<TypeSource[] | undefined> {
    if (!project.typeSources) {
        return undefined;
    }

    const existing: TypeSource[] = [];
    for (const source of project.typeSources) {
        if (await isFile(source.typesPath)) {
            existing.push(source);
        }
    }

    return existing.length ? existing : undefined;
}

function coalesceProjectsFromLegend(legend: LegendProject[]): Project[] {
    const projectMap = new Map<string, Project>();
    for (const legendProject of legend) {
        const tracePath = path.resolve(traceDir, path.basename(legendProject.tracePath));
        const typesPath = legendProject.typesPath && path.resolve(traceDir, path.basename(legendProject.typesPath));
        const typeSource = typesPath
            ? { typesPath, checkerId: legendProject.checkerId }
            : undefined;
        const key = `${legendProject.configFilePath || ""}\n${tracePath}`;

        let project = projectMap.get(key);
        if (!project) {
            project = {
                configFilePath: legendProject.configFilePath,
                tracePath,
                typeSources: typeSource ? [typeSource] : undefined,
            };
            projectMap.set(key, project);
            continue;
        }

        if (typesPath) {
            project.typeSources ??= [];
            if (!project.typeSources.some(source => source.typesPath === typesPath && source.checkerId === legendProject.checkerId)) {
                project.typeSources.push(typeSource!);
            }
        }
    }

    return Array.from(projectMap.values());
}

function isFile(path: string): Promise<boolean> {
    return fs.promises.stat(path).then(stats => stats.isFile()).catch(_ => false);
}

function throwIfNotDirectory(path: string): string {
    if (!fs.existsSync(path) || !fs.statSync(path)?.isDirectory()) {
        throw new Error(`${path} is not a directory`);
    }
    return path;
}
