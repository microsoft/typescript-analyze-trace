// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import stream = require("stream");

namespace normalizePositions {
    export type LineChar = readonly [line: number, char: number];
}

type MutableLineChar = [line: number, char: number];
type LineChar = normalizePositions.LineChar;

interface PositionWrapper {
    returnIndex: number;
    offset?: number;
    lineChar?: LineChar;
}

let freezeCache: LineChar = [-1, -1];
function freeze(lineChar: MutableLineChar): LineChar {
    if (lineChar[0] !== freezeCache[0] || lineChar[1] !== freezeCache[1]) {
        freezeCache = [lineChar[0], lineChar[1]];
    }

    return freezeCache;
}

function compareOffsets(a: number, b: number): number {
    return a - b;
}

function compareLineChars(a: LineChar, b: LineChar): number {
    return a[0] - b[0] || a[1] - b[1];
}

/**
 * @param stream A stream of string chunks with respect to which `positions` should be normalized.
 * @param positions Positions to be normalized.  NB: negative numbers will be treated as positions
 * that should be converted to line-char without but not moved past trivia.
 * @returns A list of normalized line-char positions.
 */
function normalizePositions(stream: stream.Readable, positions: ReadonlyArray<number | LineChar>): Promise<ReadonlyArray<LineChar>> {
    return positions.length === 0 ? Promise.resolve([]) : new Promise<ReadonlyArray<LineChar>>((resolve, reject) => {
        let prevCh = -1;

        stream.on("error", err => reject(err));

        // The actual event handling is in onChar and onEof below.
        // These handlers provided a simplified current- and next-char view.
        stream.on("data", chunk => {
            const text = chunk as string;
            const length = text.length;
            for (let i = 0; i < length; i++) {
                const ch = text.charCodeAt(i);
                if (prevCh >= 0) {
                    onChar(prevCh, ch);
                }
                prevCh = ch;
            }
        });

        stream.on("close", () => {
            if (prevCh >= 0) {
                onChar(prevCh, -1);
            }

            onEof();
        });

        const code_CarriageReturn = "\r".charCodeAt(0);
        const code_NewLine = "\n".charCodeAt(0);
        const code_Space = " ".charCodeAt(0);
        const code_Tab = "\t".charCodeAt(0);
        const code_Slash = "/".charCodeAt(0);
        const code_Backslash = "\\".charCodeAt(0);
        const code_Star = "*".charCodeAt(0);
        const code_Hash = "#".charCodeAt(0);
        const code_Bang = "!".charCodeAt(0);
        const code_SingleQuote = "'".charCodeAt(0);
        const code_DoubleQuote = "\"".charCodeAt(0);
        const code_OpenBrace = "{".charCodeAt(0);
        const code_CloseBrace = "}".charCodeAt(0);
        const code_OpenBracket = "[".charCodeAt(0);
        const code_CloseBracket = "]".charCodeAt(0);
        const code_Backtick = "`".charCodeAt(0);
        const code_Dollar = "$".charCodeAt(0);

        const enum State {
            Uninitialized,
            Default,
            StartSingleLineComment,
            SingleLineComment,
            StartMultiLineComment,
            MultiLineComment,
            EndMultiLineComment,
            StartShebangComment,
            ShebangComment,
            SingleQuoteString,
            SingleQuoteStringEscapeBackslash,
            SingleQuoteStringEscapeQuote,
            DoubleQuoteString,
            DoubleQuoteStringEscapeBackslash,
            DoubleQuoteStringEscapeQuote,
            TemplateString,
            TemplateStringEscapeBackslash,
            TemplateStringEscapeQuote,
            StartExpressionHole,
            Regex,
            RegexEscapeBackslash,
            RegexEscapeSlash,
            RegexEscapeOpenBracket,
            CharClass,
            CharClassEscapeBackslash,
            CharClassEscapeCloseBracket,
        }

        // We partition the positions because the varieties
        // cannot be sorted with respect to each other.
        const fixedOffsetWrappers: PositionWrapper[] = []; // Don't skip trivia
        const offsetWrappers: PositionWrapper[] = []; // Do skip trivia
        const fixedLineCharWrappers: PositionWrapper[] = []; // Don't skip trivia
        const lineCharWrappers: PositionWrapper[] = []; // Do skip trivia

        for (let i = 0; i < positions.length; i++) {
            const position = positions[i];
            if (typeof position === "number") {
                if (position < 0) {
                    fixedOffsetWrappers.push({
                        returnIndex: i,
                        offset: -position,
                    });
                }
                else {
                    offsetWrappers.push({
                        returnIndex: i,
                        offset: position,
                    });
                }
            }
            else {
                if (position[0] < 0 || position[1] < 0) {
                    fixedLineCharWrappers.push({
                        returnIndex: i,
                        lineChar: [Math.abs(position[0]), Math.abs(position[1])],
                    });
                }
                else {
                    lineCharWrappers.push({
                        returnIndex: i,
                        lineChar: position,
                    });
                }
            }
        }

        fixedOffsetWrappers.sort((a, b) => compareOffsets(a.offset!, b.offset!));
        offsetWrappers.sort((a, b) => compareOffsets(a.offset!, b.offset!));
        fixedLineCharWrappers.sort((a, b) => compareLineChars(a.lineChar!, b.lineChar!));
        lineCharWrappers.sort((a, b) => compareLineChars(a.lineChar!, b.lineChar!));

        let fixedOffsetWrappersPos = 0;
        let offsetWrappersPos = 0;
        let fixedLineCharWrappersPos = 0;
        let lineCharWrappersPos = 0;

        let currOffset = 0;
        let currLineChar: MutableLineChar = [1, 1];
        let state = State.Default;
        let braceDepth = 0;
        let templateStringBraceDepthStack: number[] = [];

        function onChar(ch: number, nextCh: number) {
            let nextState = State.Uninitialized;;
            let wrapLine = false;
            switch (ch) {
                case code_CarriageReturn:
                    if (nextCh === code_NewLine) {
                        if (state === State.ShebangComment ||
                            state === State.SingleLineComment ||
                            // Cases below are for error recovery
                            state === State.SingleQuoteString ||
                            state === State.DoubleQuoteString ||
                            state === State.Regex ||
                            state === State.CharClass) {
                            state = State.Default;
                        }
                        break;
                    }
                // Fall through
                case code_NewLine:
                    wrapLine = true;
                    if (state === State.ShebangComment ||
                        state === State.SingleLineComment) {
                        state = State.Default;
                    }
                    else if (state === State.SingleQuoteString || // Error recovery
                        state === State.DoubleQuoteString) { // Error recovery
                        state = State.Default;
                    }
                    break;

                case code_Slash:
                    if (state === State.Default) {
                        if (nextCh === code_Slash) {
                            state = State.StartSingleLineComment;
                        }
                        else if (nextCh === code_Star) {
                            // It seems like there might technically be a corner case where this is the beginning of an invalid regex
                            state = State.StartMultiLineComment;
                        }
                        else {
                            state = State.Regex;
                        }
                    }
                    else if (state === State.StartSingleLineComment) {
                        state = State.SingleLineComment;
                    }
                    else if (state === State.EndMultiLineComment) {
                        nextState = State.Default;
                    }
                    else if (state === State.Regex) {
                        nextState = State.Default;
                    }
                    else if (state === State.RegexEscapeSlash) {
                        nextState = State.Regex;
                    }
                    break;

                case code_Star:
                    if (state === State.StartMultiLineComment) {
                        state = State.MultiLineComment;
                    }
                    else if (state === State.MultiLineComment) {
                        if (nextCh === code_Slash) {
                            state = State.EndMultiLineComment;
                        }
                    }
                    break;

                case code_Hash:
                    if (currOffset === 0 && state === State.Default && nextCh === code_Bang) {
                        state = State.StartShebangComment;
                    }
                    break;

                case code_Bang:
                    if (state === State.StartShebangComment) {
                        state = State.ShebangComment;
                    }
                    break;

                case code_SingleQuote:
                    if (state === State.Default) {
                        state = State.SingleQuoteString;
                    }
                    else if (state === State.SingleQuoteStringEscapeQuote) {
                        nextState = State.SingleQuoteString;
                    }
                    else if (state === State.SingleQuoteString) {
                        nextState = State.Default;
                    }
                    break;

                case code_DoubleQuote:
                    if (state === State.Default) {
                        state = State.DoubleQuoteString;
                    }
                    else if (state === State.DoubleQuoteStringEscapeQuote) {
                        nextState = State.DoubleQuoteString;
                    }
                    else if (state === State.DoubleQuoteString) {
                        nextState = State.Default;
                    }
                    break;

                case code_Backtick:
                    if (state === State.Default) {
                        state = State.TemplateString;
                    }
                    else if (state === State.TemplateStringEscapeQuote) {
                        nextState = State.TemplateString;
                    }
                    else if (state === State.TemplateString) {
                        nextState = State.Default;
                    }
                    break;

                case code_Backslash:
                    if (state === State.SingleQuoteString) {
                        if (nextCh === code_SingleQuote) {
                            state = State.SingleQuoteStringEscapeQuote;
                        }
                        else if (nextCh === code_Backslash) {
                            state = State.SingleQuoteStringEscapeBackslash;
                        }
                    }
                    else if (state === State.DoubleQuoteString) {
                        if (nextCh === code_DoubleQuote) {
                            state = State.DoubleQuoteStringEscapeQuote;
                        }
                        else if (nextCh === code_Backslash) {
                            state = State.DoubleQuoteStringEscapeBackslash;
                        }
                    }
                    else if (state === State.TemplateString) {
                        if (nextCh === code_Backtick) {
                            state = State.TemplateStringEscapeQuote;
                        }
                        else if (nextCh === code_Backslash) {
                            state = State.TemplateStringEscapeBackslash;
                        }
                    }
                    else if (state === State.Regex) {
                        if (nextCh === code_OpenBracket) {
                            state = State.RegexEscapeOpenBracket;
                        }
                        else if (nextCh === code_Slash) {
                            state = State.RegexEscapeSlash;
                        }
                        else if (nextCh === code_Backslash) {
                            state = State.RegexEscapeBackslash;
                        }
                    }
                    else if (state === State.CharClass) {
                        if (nextCh === code_CloseBracket) {
                            state = State.CharClassEscapeCloseBracket;
                        }
                        else if (nextCh === code_Backslash) {
                            state = State.CharClassEscapeBackslash;
                        }
                    }
                    else if (state === State.SingleQuoteStringEscapeBackslash) {
                        nextState = State.SingleQuoteString;
                    }
                    else if (state === State.DoubleQuoteStringEscapeBackslash) {
                        nextState = State.DoubleQuoteString;
                    }
                    else if (state === State.TemplateStringEscapeBackslash) {
                        nextState = State.TemplateString;
                    }
                    else if (state === State.RegexEscapeBackslash) {
                        nextState = State.Regex;
                    }
                    else if (state === State.CharClassEscapeBackslash) {
                        nextState = State.CharClass;
                    }
                    break;

                case code_Dollar:
                    if (state === State.TemplateString && nextCh === code_OpenBrace) {
                        state = State.StartExpressionHole;
                    }
                    break;

                case code_OpenBrace:
                    if (state === State.Default) {
                        braceDepth++;
                    }
                    else if (state === State.StartExpressionHole) {
                        templateStringBraceDepthStack.push(braceDepth);
                        nextState = State.Default;
                    }
                    break;

                case code_CloseBrace:
                    if (templateStringBraceDepthStack.length && braceDepth === templateStringBraceDepthStack[templateStringBraceDepthStack.length - 1]) {
                        templateStringBraceDepthStack.pop();
                        state = State.TemplateString;
                    }
                    else if (state === State.Default && braceDepth > 0) { // Error recovery
                        braceDepth--;
                    }
                    break;

                case code_OpenBracket:
                    if (state === State.RegexEscapeOpenBracket) {
                        nextState = State.Regex;
                    }
                    else if (state === State.Regex) {
                        state = State.CharClass;
                    }
                    break;

                case code_CloseBracket:
                    if (state === State.CharClassEscapeCloseBracket) {
                        nextState = State.CharClass;
                    }
                    else if (state === State.CharClass) {
                        nextState = State.Regex;
                    }
                    break;
            }

            const isTrivia =
                state === State.StartSingleLineComment ||
                state === State.SingleLineComment ||
                state === State.StartMultiLineComment ||
                state === State.MultiLineComment ||
                state === State.EndMultiLineComment ||
                state === State.StartShebangComment ||
                state === State.ShebangComment ||
                ch === code_Space ||
                ch === code_Tab ||
                ch === code_NewLine ||
                ch === code_CarriageReturn ||
                /^\s$/.test(String.fromCharCode(ch));

            // This is handy when debugging
            // console.error(`${currOffset}\t${/^[a-zA-Z0-9!@#$%^&*()[\]{}\\/;':"<,>.?`~+=_\-]$/.test(String.fromCharCode(ch)) ? String.fromCharCode(ch) : "0x" + ch.toString(16)}\t(${currLineChar[0]},${currLineChar[1]})\t${isTrivia ? "Triv" : "Not"}\tS${state}\tB${braceDepth}`);

            for (; fixedOffsetWrappersPos < fixedOffsetWrappers.length && compareOffsets(fixedOffsetWrappers[fixedOffsetWrappersPos].offset!, currOffset) <= 0; fixedOffsetWrappersPos++) {
                fixedOffsetWrappers[fixedOffsetWrappersPos].offset = currOffset;
                fixedOffsetWrappers[fixedOffsetWrappersPos].lineChar = freeze(currLineChar);
            }

            for (; fixedLineCharWrappersPos < fixedLineCharWrappers.length && compareLineChars(fixedLineCharWrappers[fixedLineCharWrappersPos].lineChar!, currLineChar) <= 0; fixedLineCharWrappersPos++) {
                fixedLineCharWrappers[fixedLineCharWrappersPos].offset = currOffset;
                fixedLineCharWrappers[fixedLineCharWrappersPos].lineChar = freeze(currLineChar);
            }

            if (!isTrivia) {
                for (; offsetWrappersPos < offsetWrappers.length && compareOffsets(offsetWrappers[offsetWrappersPos].offset!, currOffset) <= 0; offsetWrappersPos++) {
                    offsetWrappers[offsetWrappersPos].offset = currOffset;
                    offsetWrappers[offsetWrappersPos].lineChar = freeze(currLineChar);
                }

                for (; lineCharWrappersPos < lineCharWrappers.length && compareLineChars(lineCharWrappers[lineCharWrappersPos].lineChar!, currLineChar) <= 0; lineCharWrappersPos++) {
                    lineCharWrappers[lineCharWrappersPos].offset = currOffset;
                    lineCharWrappers[lineCharWrappersPos].lineChar = freeze(currLineChar);
                }
            }

            currOffset++;

            if (wrapLine) {
                currLineChar[0]++;
                currLineChar[1] = 1;
            }
            else {
                currLineChar[1]++;
            }

            if (nextState !== State.Uninitialized) {
                state = nextState;
            }

            // TODO (https://github.com/microsoft/typescript-analyze-trace/issues/4)
        }

        function onEof() {
            const result: LineChar[] = [];

            const eofLineChar = freeze(currLineChar);

            for (let i = 0; i < fixedOffsetWrappersPos; i++) {
                const wrapper = fixedOffsetWrappers[i];
                result[wrapper.returnIndex] = wrapper.lineChar!;
            }

            for (let i = fixedOffsetWrappersPos; i < fixedOffsetWrappers.length; i++) {
                const wrapper = fixedOffsetWrappers[i];
                result[wrapper.returnIndex] = eofLineChar;
            }

            for (let i = 0; i < offsetWrappersPos; i++) {
                const wrapper = offsetWrappers[i];
                result[wrapper.returnIndex] = wrapper.lineChar!;
            }

            for (let i = offsetWrappersPos; i < offsetWrappers.length; i++) {
                const wrapper = offsetWrappers[i];
                result[wrapper.returnIndex] = eofLineChar;
            }

            for (let i = 0; i < fixedLineCharWrappersPos; i++) {
                const wrapper = fixedLineCharWrappers[i];
                result[wrapper.returnIndex] = wrapper.lineChar!;
            }

            for (let i = fixedLineCharWrappersPos; i < fixedLineCharWrappers.length; i++) {
                const wrapper = fixedLineCharWrappers[i];
                result[wrapper.returnIndex] = eofLineChar;
            }

            for (let i = 0; i < lineCharWrappersPos; i++) {
                const wrapper = lineCharWrappers[i];
                result[wrapper.returnIndex] = wrapper.lineChar!;
            }

            for (let i = lineCharWrappersPos; i < lineCharWrappers.length; i++) {
                const wrapper = lineCharWrappers[i];
                result[wrapper.returnIndex] = eofLineChar;
            }

            resolve(result);
        }
    });
}

export = normalizePositions;