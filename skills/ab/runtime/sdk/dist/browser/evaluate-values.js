import { ABError } from "../errors/index.js";
const ARGUMENTS_FORMAT = "ab.evaluate.arguments";
const RESULT_FORMAT = "ab.evaluate.result";
const FORMAT_VERSION = 1;
const MAX_DEPTH = 100;
export function buildEvaluateScript(fn, args) {
    const source = serializePageFunction(fn);
    const payload = {
        format: ARGUMENTS_FORMAT,
        version: FORMAT_VERSION,
        items: args.map((value, index) => encodeValue(value, `$[${index}]`, new Set(), 0)),
    };
    return `(${pageEvaluate.toString()})(${source}, ${JSON.stringify(payload)})`;
}
export function deserializeEvaluateResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw protocolError("evaluate result envelope must be an object");
    }
    const envelope = value;
    if (envelope.format !== RESULT_FORMAT || envelope.version !== FORMAT_VERSION || !("value" in envelope)) {
        throw protocolError("evaluate result envelope has an unsupported format or version");
    }
    return decodeValue(envelope.value, "$", 0);
}
function encodeValue(value, path, ancestors, depth) {
    assertDepth(depth, path, "serialization_failed");
    if (value === null)
        return { type: "null" };
    switch (typeof value) {
        case "undefined": return { type: "undefined" };
        case "string": return { type: "string", value };
        case "boolean": return { type: "boolean", value };
        case "number": return { type: "number", value: encodeNumber(value) };
        case "bigint": return { type: "bigint", value: value.toString() };
        case "function":
        case "symbol":
            throw serializationError(path, `${typeof value} values are not serializable`);
        case "object": break;
        default: throw serializationError(path, `unsupported value type ${typeof value}`);
    }
    const object = value;
    if (ancestors.has(object))
        throw serializationError(path, "circular values are not serializable");
    ancestors.add(object);
    try {
        if (Array.isArray(value)) {
            const items = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    throw serializationError(`${path}[${index}]`, "sparse arrays are not serializable");
                }
                items.push(encodeValue(value[index], `${path}[${index}]`, ancestors, depth + 1));
            }
            rejectArrayExtras(value, path);
            return { type: "array", value: items };
        }
        if (value instanceof Date) {
            if (Number.isNaN(value.getTime()))
                throw serializationError(path, "invalid Date is not serializable");
            rejectEnumerableProperties(value, path);
            return { type: "date", value: value.toISOString() };
        }
        if (value instanceof RegExp) {
            rejectEnumerableProperties(value, path);
            return { type: "regexp", value: { pattern: value.source, flags: value.flags } };
        }
        if (value instanceof Map) {
            rejectEnumerableProperties(value, path);
            return {
                type: "map",
                value: [...value.entries()].map(([key, item], index) => [
                    encodeValue(key, `${path}.mapKey[${index}]`, ancestors, depth + 1),
                    encodeValue(item, `${path}.mapValue[${index}]`, ancestors, depth + 1),
                ]),
            };
        }
        if (value instanceof Set) {
            rejectEnumerableProperties(value, path);
            return {
                type: "set",
                value: [...value].map((item, index) => encodeValue(item, `${path}.set[${index}]`, ancestors, depth + 1)),
            };
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) {
            throw serializationError(path, `${value.constructor?.name ?? "custom object"} is not serializable`);
        }
        rejectEnumerableSymbols(value, path);
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const entries = Object.keys(value).map((key) => {
            const descriptor = descriptors[key];
            if (!descriptor || !("value" in descriptor)) {
                throw serializationError(`${path}.${key}`, "accessor properties are not serializable");
            }
            return [key, encodeValue(descriptor.value, `${path}.${key}`, ancestors, depth + 1)];
        });
        return { type: "object", value: entries };
    }
    finally {
        ancestors.delete(object);
    }
}
function decodeValue(value, path, depth) {
    assertDepth(depth, path, "protocol_error");
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
        throw protocolError(`invalid evaluate value at ${path}`);
    }
    const encoded = value;
    switch (encoded.type) {
        case "undefined": return undefined;
        case "null": return null;
        case "string": return requirePrimitive(encoded.value, "string", path);
        case "boolean": return requirePrimitive(encoded.value, "boolean", path);
        case "number": return decodeNumber(encoded.value, path);
        case "bigint":
            try {
                return BigInt(requirePrimitive(encoded.value, "string", path));
            }
            catch {
                throw protocolError(`invalid bigint at ${path}`);
            }
        case "date": {
            const text = requirePrimitive(encoded.value, "string", path);
            const date = new Date(text);
            if (Number.isNaN(date.getTime()) || date.toISOString() !== text)
                throw protocolError(`invalid date at ${path}`);
            return date;
        }
        case "regexp":
            try {
                return new RegExp(encoded.value.pattern, encoded.value.flags);
            }
            catch {
                throw protocolError(`invalid regexp at ${path}`);
            }
        case "array": return encoded.value.map((item, index) => decodeValue(item, `${path}[${index}]`, depth + 1));
        case "set": return new Set(encoded.value.map((item, index) => decodeValue(item, `${path}.set[${index}]`, depth + 1)));
        case "map": return new Map(encoded.value.map(([key, item], index) => [
            decodeValue(key, `${path}.mapKey[${index}]`, depth + 1),
            decodeValue(item, `${path}.mapValue[${index}]`, depth + 1),
        ]));
        case "object": {
            const output = {};
            const keys = new Set();
            for (const [key, item] of encoded.value) {
                if (keys.has(key))
                    throw protocolError(`duplicate object key ${key} at ${path}`);
                keys.add(key);
                Object.defineProperty(output, key, {
                    value: decodeValue(item, `${path}.${key}`, depth + 1),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
            return output;
        }
    }
}
function pageEvaluate(fn, payload) {
    const maxDepth = 100;
    const decode = (value, depth) => {
        if (depth > maxDepth)
            throw new Error("AB evaluate argument exceeds maximum depth");
        switch (value.type) {
            case "undefined": return undefined;
            case "null": return null;
            case "string":
            case "boolean": return value.value;
            case "number": {
                if (typeof value.value === "number")
                    return value.value;
                if (value.value === "-0")
                    return -0;
                if (value.value === "NaN")
                    return NaN;
                if (value.value === "Infinity")
                    return Infinity;
                if (value.value === "-Infinity")
                    return -Infinity;
                throw new Error("Invalid AB evaluate number");
            }
            case "bigint": return BigInt(value.value);
            case "date": return new Date(value.value);
            case "regexp": return new RegExp(value.value.pattern, value.value.flags);
            case "array": return value.value.map((item) => decode(item, depth + 1));
            case "set": return new Set(value.value.map((item) => decode(item, depth + 1)));
            case "map": return new Map(value.value.map(([key, item]) => [decode(key, depth + 1), decode(item, depth + 1)]));
            case "object": return Object.fromEntries(value.value.map(([key, item]) => [key, decode(item, depth + 1)]));
        }
    };
    const encode = (value, ancestors, depth) => {
        if (depth > maxDepth)
            throw new Error("AB evaluate result exceeds maximum depth");
        if (value === null)
            return { type: "null" };
        if (value === undefined)
            return { type: "undefined" };
        if (typeof value === "string")
            return { type: "string", value };
        if (typeof value === "boolean")
            return { type: "boolean", value };
        if (typeof value === "number") {
            const number = Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : value;
            return { type: "number", value: number };
        }
        if (typeof value === "bigint")
            return { type: "bigint", value: value.toString() };
        if (typeof value !== "object")
            throw new Error(`${typeof value} result values are not serializable`);
        if (ancestors.has(value))
            throw new Error("circular result values are not serializable");
        ancestors.add(value);
        try {
            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index += 1) {
                    if (!Object.prototype.hasOwnProperty.call(value, index))
                        throw new Error("sparse result arrays are not serializable");
                }
                return { type: "array", value: value.map((item) => encode(item, ancestors, depth + 1)) };
            }
            if (value instanceof Date)
                return { type: "date", value: value.toISOString() };
            if (value instanceof RegExp)
                return { type: "regexp", value: { pattern: value.source, flags: value.flags } };
            if (value instanceof Map)
                return { type: "map", value: [...value].map(([key, item]) => [encode(key, ancestors, depth + 1), encode(item, ancestors, depth + 1)]) };
            if (value instanceof Set)
                return { type: "set", value: [...value].map((item) => encode(item, ancestors, depth + 1)) };
            if (Object.getPrototypeOf(value) !== Object.prototype)
                throw new Error("custom result objects are not serializable");
            const descriptors = Object.getOwnPropertyDescriptors(value);
            return {
                type: "object",
                value: Object.keys(value).map((key) => {
                    const descriptor = descriptors[key];
                    if (!descriptor || !("value" in descriptor))
                        throw new Error("accessor result properties are not serializable");
                    return [key, encode(descriptor.value, ancestors, depth + 1)];
                }),
            };
        }
        finally {
            ancestors.delete(value);
        }
    };
    return Promise.resolve(fn(...payload.items.map((item) => decode(item, 0)))).then((result) => ({
        format: "ab.evaluate.result",
        version: 1,
        value: encode(result, new Set(), 0),
    }));
}
function serializePageFunction(fn) {
    const source = Function.prototype.toString.call(fn).trim();
    if (!source || source.includes("[native code]"))
        throw serializationError("$function", "a user-defined function is required");
    if (isFunctionExpression(source))
        return `(${source})`;
    const candidates = /^async\s+\*/.test(source)
        ? [`async function* ${source.replace(/^async\s+\*\s*/, "")}`]
        : /^async\s+/.test(source)
            ? [`async function ${source.replace(/^async\s+/, "")}`]
            : /^\*/.test(source)
                ? [`function* ${source.replace(/^\*\s*/, "")}`]
                : [`function ${source}`];
    const normalized = candidates.find(isFunctionExpression);
    if (!normalized)
        throw serializationError("$function", "unsupported function syntax");
    return `(${normalized})`;
}
function isFunctionExpression(source) {
    try {
        return typeof Function(`return (${source})`)() === "function";
    }
    catch {
        return false;
    }
}
function encodeNumber(value) {
    if (Object.is(value, -0))
        return "-0";
    if (Number.isNaN(value))
        return "NaN";
    if (value === Infinity)
        return "Infinity";
    if (value === -Infinity)
        return "-Infinity";
    return value;
}
function decodeNumber(value, path) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value === "-0")
        return -0;
    if (value === "NaN")
        return NaN;
    if (value === "Infinity")
        return Infinity;
    if (value === "-Infinity")
        return -Infinity;
    throw protocolError(`invalid number at ${path}`);
}
function rejectArrayExtras(value, path) {
    const extra = Object.keys(value).find((key) => !/^\d+$/.test(key) || Number(key) >= value.length);
    if (extra !== undefined)
        throw serializationError(`${path}.${extra}`, "extra array properties are not serializable");
    rejectEnumerableSymbols(value, path);
}
function rejectEnumerableProperties(value, path) {
    if (Object.keys(value).length)
        throw serializationError(path, "extra enumerable properties are not serializable");
    rejectEnumerableSymbols(value, path);
}
function rejectEnumerableSymbols(value, path) {
    if (Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol))) {
        throw serializationError(path, "enumerable Symbol keys are not serializable");
    }
}
function requirePrimitive(value, expected, path) {
    if (typeof value !== expected)
        throw protocolError(`expected ${expected} at ${path}`);
    return value;
}
function assertDepth(depth, path, kind) {
    if (depth > MAX_DEPTH) {
        throw new ABError({ kind, stage: "sdk.evaluate.value", message: `value exceeds maximum depth ${MAX_DEPTH} at ${path}` });
    }
}
function serializationError(path, reason) {
    return new ABError({
        kind: "serialization_failed",
        stage: "sdk.evaluate.serialize",
        message: `cannot serialize evaluate value at ${path}: ${reason}`,
        details: { path, reason },
    });
}
function protocolError(message) {
    return new ABError({ kind: "protocol_error", stage: "sdk.evaluate.deserialize", message });
}
//# sourceMappingURL=evaluate-values.js.map