# @typescript/analyze-trace
Tool for analyzing the output of `tsc --generateTrace` automatically, rather than following the steps [here](https://github.com/microsoft/TypeScript/wiki/Performance-Tracing).

Note: The goal is to identify clear-cut hot-spots and provide enough context to extract a small repro.
The repro can then be used as the basis of a bug report or a starting point for manual code inspection or profiling.

## Usage

First, build your project with `tsc --generateTrace traceDir`.  This will create a new `traceDir` directory with paired trace and types files.

Next, install `@typescript/analyze-trace` to make its various commands available in your project.

For a sorted list of compilation hot-spots, run `npx analyze-trace traceDir`.
Pass `--help` to learn more about configuration options.
For best results, run the analyzer on a machine where the paths in the trace file(s) resolve correctly.

For a simplified view of a types file (useful when investigating an individual trace), run `npx simplify-trace-types traceDir\types.json output_path`.
Note that the resulting file is for human consumption and should not be passed to the analyzer (i.e. don't clobber the original).

To pretty-print individual types from a types file (faster than processing the entire file), run `npx print-types traceDir\types.json id+`.

## Deployment

To publish a new version of this package, change the version in `package.json` and push to main.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
