export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
