/**
 * Helper to preserve dynamic import() for ES modules in CommonJS output
 * TypeScript will transform import() to require() when compiling to CommonJS,
 * so we use Function to preserve the runtime import() call
 */
export function dynamicImport<T = any>(moduleSpecifier: string): Promise<T> {
  // Using Function constructor to preserve runtime import() call
  // This prevents TypeScript from transforming it to require()
  return new Function("return import(arguments[0])")(
    moduleSpecifier
  ) as Promise<T>;
}

export function once<T>(fn: () => T) {
  let result: T | undefined;
  return () => {
    if (result === undefined) {
      result = fn();
    }
    return result;
  };
}
