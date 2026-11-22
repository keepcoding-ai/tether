export const EXE_NAME: string
export const EXE_ICON: string
export function identityOptions(o: { version: string, icon?: string }): { icon: string, 'file-version': string, 'product-version': string, 'version-string': Record<string, string> }
export function brandExecutable(exe: string, o?: { version?: string }): Promise<void>
