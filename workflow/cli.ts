#!/usr/bin/env node
/** Codex host entry: sends exactly the supplied JSON to the local service. */
import { storagePaths } from './paths.ts';
import { existsSync, readFileSync } from 'node:fs';
const [method,path,file]=process.argv.slice(2);
if(!method||!path||!path.startsWith('/api/')){console.error('WORKFLOW_TOKEN_FILE=... node workflow/cli.ts GET /api/board\n... POST /api/messages message.json');process.exit(1);}
const configPath=process.env.WORKFLOW_CONFIG || new URL('./config.local.json',import.meta.url);
const raw=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
const {dirname,resolve}=await import('node:path');
const {fileURLToPath}=await import('node:url');
const configBase=dirname(typeof configPath==='string'?resolve(configPath):fileURLToPath(configPath));
const token=readFileSync(process.env.WORKFLOW_TOKEN_FILE||storagePaths(raw,configBase).tokenFile,'utf8').trim();
const body=file?readFileSync(file,'utf8'):undefined;if(body)JSON.parse(body);
const base=process.env.WORKFLOW_URL||'http://127.0.0.1:4317';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw new Error('Local loopback URL required');
const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body});
console.log(await response.text());if(!response.ok)process.exitCode=1;
