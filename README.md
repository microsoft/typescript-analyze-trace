# @typescript/analyze-trace

A tool for analyzing the output of `tsc --generateTrace` in a fast and digestible way (rather than more involved diagnostics [here](https://github.com/microsoft/TypeScript/wiki/Performance-Tracing)).

Note: The goal is to identify clear-cut hot-spots and provide enough context to extract a small repro.
The repro can then be used as the basis of a bug report or a starting point for manual code inspection or profiling.

## Usage

The short version is to run these commands:

```sh
tsc -p tsconfig.json --generateTrace traceDir
npm install --no-save @typescript/analyze-trace
npx analyze-trace traceDir
```

Each of these commands do the following:

1. First, build your project with `--generateTrace` targeting a specific directory.
   `tsc -p tsconfig.json --generateTrace traceDir` will create a new `traceDir` directory with paired trace and types files.
   If your configuration file is not `tsconfig.json`, you will need to adjust the command.
2. Installing `@typescript/analyze-trace` makes its various commands available in your project.
3. Running `npx analyze-trace traceDir` outputs a sorted list of compilation hot-spots - places where TypeScript is taking a high amount of time.

For best results, the analyzer should run on trace files that were generated in the same relative location.
If the trace files fall out of date with your project, you may see different results.
https://github.com/microsoft/typescript-analyze-trace/issues/29
You can run `npx analyze-trace --help` to find out about other options including:

Option                    | Default | Description
--------------------------|---------|-------------------------------------------------------------------------------
`--skipMillis [number]`   | `100`   | Suppress events that take less than the specified number of milliseocnds
`--color [boolean]`       | `true`  | Color the output to make it easier to read.
`--expandTypes [boolean]` | `true`  | Expand the names of types when printing them.
`--json [boolean]`        | `false` | *Experimental and unstable*: Produce JSON output for programmatic consumption.

For a simplified view of a `types.json` file (useful when investigating an individual trace), you can run `npx simplify-trace-types traceDir/types.json output.txt`.
Note that the resulting file is for human consumption and should not be passed to the analyzer (i.e. don't clobber the original).

### Interpreting Results

The `analyze-trace` output will try to highlight the most expensive portions of a compilation that it was able to measure (a.k.a. "hot spots").
Each hot spot may have a breakdown of other contributing hot spots.

`analyze-trace` will also try to point out when multiple versions of the same npm package were loaded and type-checked.

Output currently looks like the following:

```
Hot Spots
├─ Check file /some/sample/project/node_modules/typescript/lib/lib.dom.d.ts (899ms)
├─ Check file /some/sample/project/node_modules/@types/lodash/common/common.d.ts (530ms)
│  └─ Compare types 50638 and 50640 (511ms)
│     └─ Compare types 50643 and 50642 (511ms)
│        └─ Compare types 50648 and 50644 (511ms)
│           └─ Determine variance of type 50492 (511ms)
│              └─ Compare types 50652 and 50651 (501ms)
|                 └─ ...
├─ Check file /some/sample/project/node_modules/@types/babel__traverse/index.d.ts (511ms)
└─ Check file /some/sample/project/node_modules/@types/react/index.d.ts (507ms)
```

Each step here is annotated with check times (e.g. checking two types in lodash took over 500ms).

Some common messages

Message | Explanation
--------|------------
"Compare types 1234 and 5678" | TypeScript had to check whether non-trivial types with internal IDs `1234` and `5678` were related.
"Determine variance of type 1234" | TypeScript had to check whether a `Foo<T>` was compatible with a `Foo<U>`. Instead of calculating all the members of `Foo<T>` and `Foo<U>` and comparing them, calculating variance allows TypeScript to know whether in such cases, it can just relate `T` to `U`, or `U` to `T`. Variance calculation requires a few up-front comparisons to possibly save all future ones.
"Emit declaration file" | Generating the declaration file for the current file took a while.

Other messages correspond roughly to specific functions in the compiler, but are *typically* self-explanatory.

The file names will be the first indicators of where to look.
Often, type IDs are used in place of more precise (but often verbose) type names.
The `types.json` file will provide a way to look these up.

### Acting on Results

Once you've found culprit code, it's worth trying to create a minimal version of this code to isolate issues and experiment.
In some cases you can try to rewrite or simplify your code, and [our team has a few suggestions for common issues here](https://github.com/microsoft/TypeScript/wiki/Performance#writing-easy-to-compile-code).
If culprit code occurs in a library, it may be worth filing an issue or sending a pull request to make the same simplifications.

If you believe you have a minimal isolated reproduction of the issue that might be worth optimizing in TypeScript itself, [you are encouraged to file an issue](https://github.com/microsoft/TypeScript/issues/new/choose).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
