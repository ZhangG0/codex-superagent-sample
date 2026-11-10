import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Stable user data location, independent of the source checkout. */
export function dataDirectory(platform = process.platform, home = homedir(), env = process.env): string {
    if (env.WORKFLOW_DATA_DIR) return resolve(env.WORKFLOW_DATA_DIR);
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'codex-superagent-sample');
    if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'codex-superagent-sample');
    return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'codex-superagent-sample');
}
export function storagePaths(raw: {database?: string; tokenFile?: string}, base: string) {
    return {database: raw.database ? resolve(base, raw.database) : join(dataDirectory(), 'workflow.sqlite3'),
        tokenFile: raw.tokenFile ? resolve(base, raw.tokenFile) : join(dataDirectory(), 'workflow.token')};
}
