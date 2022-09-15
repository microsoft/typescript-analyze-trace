# @typescript/analyze-trace

[`@typescript/analyze-trace`](https://github.com/microsoft/typescript-analyze-trace) is tool for analyzing the output of `tsc --generateTrace` in a fast and digestible way (rather than more involved diagnostics [here](https://github.com/microsoft/TypeScript/wiki/Performance-Tracing)).

Note: The goal is to identify clear-cut hot-spots and provide enough context to extract a small repro.
The repro can then be used as the basis of a bug report or a starting point for manual code inspection or profiling.

## Usage

The short version is to run these commands:

```sh
tsc -p path/to/tsconfig.json --generateTrace traceDir
npm install --no-save @typescript/analyze-trace
npx analyze-trace traceDir
```

Each of these commands do the following:

1. Building your project with `--generateTrace` targeting a specific directory (e.g.`tsc -p path/to/tsconfig.json --generateTrace traceDir`) will create a new `traceDir` directory with paired trace and types files.
   Note that running with `-b`/`--build` mode works as well.
2. Installing `@typescript/analyze-trace` makes its various commands available in your project.
3. Running `npx analyze-trace traceDir` outputs a sorted list of compilation hot-spots - places where TypeScript is taking a high amount of time.

The analyzer tries to refer back to files from your project to provide better output, and uses relative paths to do so.
If your project changed since running `tsc --generateTrace`, or you moved your trace output directory, then the tool's results may be misleading.
For best results, re-run `--generateTrace` when files and dependencies are updated, and ensure the trace output is always in the same relative location with respect to the input project.

You can run `npx analyze-trace --help` to find out about other options including:

Option                    | Default | Description
--------------------------|---------|-------------------------------------------------------------------------------
`--skipMillis [number]`   | `100`   | Suppress events that take less than the specified number of milliseconds. Reduce this value to see more output (maybe on faster machines), and increase it to reduce clutter.
`--forceMillis [number]`  | `500`   | Report all un-skipped events that take longer than the specified number of milliseconds. Reduce it to reveal more potential hot-spots that the built-in heuristic will not flag. Note that `forceMillis` is always lower-bounded by `skipMillis`.
`--color [boolean]`       | `true`  | Color the output to make it easier to read. Turn this off when redirecting output to a file.
`--expandTypes [boolean]` | `true`  | Expand the names of types when printing them. Turn this off when types are too verbose.
`--json [boolean]`        | `false` | *Experimental and unstable*: Produce JSON output for programmatic consumption.

For a simplified view of a `types.json` file (useful when investigating an individual trace), you can run `npx simplify-trace-types traceDir/types.json output.txt`.
Note that the resulting file is for human consumption and should not be passed to the analyzer (i.e. don't clobber the original).

### Interpreting Results

The `analyze-trace` output will try to highlight the most expensive portions of a compilation that it was able to measure (a.k.a. "hot spots").
Each hot spot may have a breakdown of other contributing hot spots.

#### Hot Spots

`analyze-trace` will also try to point out when multiple versions of the same npm package were loaded and type-checked.

Output may look like the following:

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

Some common messages include the following:

Message | Explanation
--------|------------
"Compare types 1234 and 5678" | TypeScript had to check whether two types with internal IDs `1234` and `5678` were related.
"Determine variance of type 1234" | TypeScript had to check whether a `Foo<T>` was compatible with a `Foo<U>`. Instead of calculating all the members of `Foo<T>` and `Foo<U>` and comparing them, calculating variance allows TypeScript to know whether in such cases, it can just relate `T` to `U`, or `U` to `T`. Variance calculation requires a few up-front comparisons to possibly save all future ones.
"Emit declaration file" | Generating the declaration file for the current file took a while.
"Consider adding `import "./some/import/path"` which is used in 1234 places" | TypeScript's `--declaration` emit needed to generate 1234 imports for `./some/import/path`. Consider directly importing this path so the type-checker can avoid emitting the same path over and over in the declaration file. Also consider using [explicit type annotations](https://github.com/microsoft/TypeScript/wiki/Performance#using-type-annotations) so the type-checker can avoid time calculating the best path to a module and how to best display the type at all.

Other messages correspond roughly to specific functions in the compiler, but are *typically* self-explanatory.

File names will be the first indicators of where to look.
Often, type IDs are used in place of more precise (but often verbose) type names, regardless of whether `--expandTypes` is on.
The `types.json` file will provide a way to look these up.

#### Duplicate Packages

`analyze-trace` will point out instances of duplicate packages in `node_modules`.
These can be caused by multiple projects in a mono-repo that use different versions of the same package, or possibly from dependencies in `node_modules` that all specify different versions a library.

Duplicate packages may or may not be expected, but loading up multiple copies of a library can have negative effects on a build.
For one, they add more time to TypeScript's parsing, binding, and possibly checking stages.
Beyond that, duplicate copies of the same types may end up being passed around and compared to each other.
Because these types don't share the same root identities, fewer optimizations can be made around them.

### Acting on Results

#### Hot Spots

Once you've found the "culprit" code that's making your build slow, try to create a minimal version of this code to isolate the issue and experiment.
In some cases you can try to rewrite or simplify your code, and [our team has a few suggestions for common issues here](https://github.com/microsoft/TypeScript/wiki/Performance#writing-easy-to-compile-code).
If culprit code occurs in a library, it may be worth filing an issue with that library or sending a pull request to provide simplifications.

If you believe you have a minimal isolated reproduction of the issue that might be worth optimizing in TypeScript itself, [you are encouraged to file an issue](https://github.com/microsoft/TypeScript/issues/new/choose).

#### Duplicate Packages

Updating projects within your monorepo to share the same dependencies may be one way to fix this issue.
Updating your dependencies may be another, though it won't always be the case that the most up-to-date versions of your dependencies list their dependencies in a compatible way.
If libraries you consume cannot be updated to list compatible dependency ranges, consider using [`overrides` in `package.json` for npm](https://docs.npmjs.com/cli/v8/configuring-npm/package-json#overrides) or [for pnpm](https://pnpm.io/package_json#pnpmoverrides), or [`resolutions` in `package.json` for Yarn](https://classic.yarnpkg.com/lang/en/docs/selective-version-resolutions/).

#### Iterating on Results

You may want to tweak the `--skipMillis` and `--forceMillis` options to uncover hot spots that `analyze-trace` may not reveal.

You may also want to try [visualizing a performance trace](https://github.com/microsoft/TypeScript/wiki/Performance-Tracing)) for a more detailed view.
Iterating between the `analyze-trace` tool and an interactive visualizer might be a helpful workflow.


Reading up further on [the TypeScript compiler's performance diagnostics page](https://github.com/microsoft/TypeScript/wiki/Performance) may provide ideas and options for your team as well.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
