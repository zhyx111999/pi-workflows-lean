/** Lossless JSON copies for checkpoint payloads and responses that must survive persistence exactly. */
/**
 * Copy a checkpoint payload or response that must survive persistence exactly:
 * only plain objects, dense arrays, strings, finite numbers, booleans and null
 * are accepted; anything a JSON round trip would change throws a TypeError.
 */
export function cloneDurableJsonValue(value, label) {
    const active = new WeakSet();
    const invalid = (cause) => {
        throw new TypeError(`${label} must be a lossless JSON value`, cause === undefined ? undefined : { cause });
    };
    const clone = (item, depth) => {
        if (item === null || typeof item === "string" || typeof item === "boolean")
            return item;
        if (typeof item === "number")
            return Number.isFinite(item) ? item : invalid();
        if (typeof item !== "object" || depth > 100)
            return invalid();
        if (active.has(item))
            return invalid();
        active.add(item);
        try {
            if (Array.isArray(item)) {
                const ownKeys = Reflect.ownKeys(item);
                if (ownKeys.some((key) => typeof key !== "string" ||
                    (key !== "length" && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)))) {
                    return invalid();
                }
                const arrayCopy = [];
                for (let index = 0; index < item.length; index++) {
                    const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
                        return invalid();
                    arrayCopy.push(clone(descriptor.value, depth + 1));
                }
                return arrayCopy;
            }
            const prototype = Object.getPrototypeOf(item);
            const objectConstructor = prototype === null ? Object : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
            if (prototype !== null && (typeof objectConstructor !== "function" || objectConstructor.name !== "Object")) {
                return invalid();
            }
            const copy = {};
            for (const key of Reflect.ownKeys(item)) {
                if (typeof key !== "string")
                    return invalid();
                const descriptor = Object.getOwnPropertyDescriptor(item, key);
                if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
                    return invalid();
                Object.defineProperty(copy, key, {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: clone(descriptor.value, depth + 1),
                });
            }
            return copy;
        }
        catch (error) {
            return invalid(error);
        }
        finally {
            active.delete(item);
        }
    };
    return clone(value, 0);
}
