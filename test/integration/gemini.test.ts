import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
import { run as runCli } from "#src/cli/main.js";
import { createProcessRunner } from "#src/process/runner.js";
import { completed } from "../support/adapter-conformance.js";
import type { CliEnvironment } from "#src/cli/context.js";
import { createGeminiAdapter } from "#src/adapters/gemini.js";
import type { ProcessSpec } from "#src/process/runner.js";

it("contains MCP startup during the documented native login with a fresh UUID each time", async () => {
  const documentation = await readFile(
    new URL("../../docs/gemini-cli/gemini-development.md", import.meta.url),
    "utf8",
  );
  const command = /```bash\n([\s\S]*?)\n```/.exec(documentation)?.[1];
  if (!command) throw new Error("Native login shell command is missing");
  const home = await mkdtemp(join(tmpdir(), "gemini-documented-login-"));
  const profile = join(home, ".agent-waker-gemini");
  const bin = join(home, "bin");
  try {
    await mkdir(join(profile, "work"), { recursive: true });
    await mkdir(bin);
    const executable = join(bin, "gemini");
    await writeFile(
      executable,
      `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,cliHome:process.env.GEMINI_CLI_HOME,cwd:process.cwd()}));\n`,
    );
    await chmod(executable, 0o700);
    const run = promisify(execFile);
    const options = {
      env: {
        HOME: home,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      timeout: 5_000,
    };
    const records: unknown[] = [];
    for (let invocation = 0; invocation < 2; invocation++) {
      const { stdout, stderr } = await run(
        "/bin/bash",
        ["-c", command],
        options,
      );
      expect(stderr).toBe("");
      const record: unknown = JSON.parse(stdout);
      expect(record).toEqual({
        args: [
          "--ignore-env",
          "-e",
          "none",
          "--allowed-mcp-server-names",
          expect.stringMatching(
            /^agent-waker-no-mcp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
        ],
        home: profile,
        cliHome: profile,
        cwd: await realpath(join(profile, "work")),
      });
      records.push(record);
    }
    expect(records[1]).not.toEqual(records[0]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("activates Gemini through the real app and ProcessRunner using an executable source-synthetic provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-e2e-"));
  try {
    const bin = join(home, "bin");
    await mkdir(bin);
    vi.stubEnv("PATH", bin);
    vi.stubEnv("HOME", home);
    await mkdir(join(home, ".git"));
    await writeFile(join(home, "GEMINI.md"), "ANCESTOR CONTEXT");
    const profile = join(home, ".agent-waker-gemini");
    await mkdir(profile);
    await writeFile(join(profile, "GEMINI.md"), "PROFILE CONTEXT");
    const memorySource = await readFile(
      join(
        import.meta.dirname,
        "../fixtures/gemini/native-memory-discovery.txt",
      ),
      "utf8",
    );
    const memoryCode = transpileModule(memorySource.replaceAll("export ", ""), {
      compilerOptions: {
        target: ScriptTarget.ES2022,
        module: ModuleKind.ESNext,
      },
    }).outputText;
    const executable = join(bin, "gemini");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('0.62.0');process.exit(0)}
// v0.62.0 settings.ts loads system scopes only after security.ts validates
// root ownership + non-writability for the file and every ancestor (POSIX).
const path=require('node:path');
;(async()=>{
const load=p=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};
const loadSystem=p=>{
 if(!fs.existsSync(p))return {};
 let current=path.resolve(p);
 for(;;){const st=fs.statSync(current);if(st.uid!==0||(st.mode&0o022)){console.error('Security Warning: Skipping system settings');return {}}const parent=path.dirname(current);if(parent===current)break;current=parent}
 return load(p);
};
const defaults=loadSystem(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH);
const system=loadSystem(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
const user=load(path.join(process.env.GEMINI_CLI_HOME,'.gemini','settings.json'));
const workspace=load(path.join(process.cwd(),'.gemini','settings.json'));
const settings={...defaults,...user,...workspace,...system};
if(settings.security?.auth?.selectedType!=='oauth-personal')process.exit(41);
if(fs.existsSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH)||fs.existsSync(process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH))process.exit(97);
const discovered=await(async()=>{
 const fs=require('node:fs/promises');
 const fsSync=require('node:fs');
 const toAbsolutePath=p=>path.resolve(p);
 const normalizePath=p=>path.resolve(p);
 const homedir=()=>process.env.GEMINI_CLI_HOME;
 const GEMINI_DIR='.gemini';
 const PROJECT_MEMORY_INDEX_FILENAME='MEMORY.md';
 const getAllGeminiMdFilenames=()=>['GEMINI.md'];
 const logger={debug(){},warn(){},error(){}};
 const debugLogger=logger;
 const getErrorMessage=String;
 ${memoryCode}
 const baseline=await getEnvironmentMemoryPaths([process.cwd()]);
 if(!baseline.includes(path.join(fsSync.realpathSync(process.env.HOME),'GEMINI.md'))||!baseline.includes(path.join(path.dirname(fsSync.realpathSync(process.env.HOME)),'GEMINI.md')))process.exit(94);
 return getEnvironmentMemoryPaths([process.cwd()],settings.context?.memoryBoundaryMarkers);
})();
if(discovered.length)process.exit(95);
const entries=fs.readdirSync(process.cwd());
if(entries.length || process.env.GEMINI_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE!=='false' || settings.security.auth.enforcedType!=='oauth-personal' || settings.billing.overageStrategy!=='never')process.exit(99);
// admin_controls/mcpUtils inject required servers even when local mcpServers={};
// native isBlockedBySettings admits an exact allowedNames match before connect.
const required={'agent-waker-no-mcp':{url:'https://admin.example.invalid/mcp'}};
const servers={...settings.mcpServers,...required};
const names=process.argv[process.argv.indexOf('--allowed-mcp-server-names')+1].split(',');
if(!names.length||Object.keys(servers).some(name=>names.includes(name)))process.exit(96);
if(settings.model.maxSessionTurns===0){console.error('[ERROR] '+JSON.stringify({error:{type:'FatalTurnLimitedError',message:'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',code:53}}));process.exit(53)}
if(settings.model.maxSessionTurns!==1)process.exit(98);
console.log(JSON.stringify({response:'OK'}));
})();
`,
    );
    await chmod(executable, 0o700);
    const config = join(home, ".config", "agent-waker");
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "config.yaml"),
      "version: 1\ntimezone: UTC\nagents:\n  claude:\n    enabled: false\n  codex:\n    enabled: false\n  gemini:\n    enabled: true\n",
    );
    let out = "";
    let err = "";
    const env = {
      PATH: bin,
      HOME: home,
      GEMINI_API_KEY: "must-not-leak",
      GOOGLE_APPLICATION_CREDENTIALS: "must-not-leak",
      GEMINI_CLI_EXP_AGENT: "true",
    };
    const environment: CliEnvironment = {
      argv: ["run", "gemini"],
      env,
      home,
      platform: "darwin",
      uid: 501,
      isTty: false,
      now: () => Date.parse("2026-10-05T07:00:00Z"),
      write: (t) => {
        out += t;
      },
      writeError: (t) => {
        err += t;
      },
      execPath: process.execPath,
      entrypoint: "/fixture/bin.js",
      systemTimezone: "UTC",
      runner: createProcessRunner({ env }),
    };
    const code = await runCli(environment);
    expect(code, JSON.stringify({ out, err })).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Activated");
    expect(
      await readFile(
        join(home, ".local", "state", "agent-waker", "state.json"),
        "utf8",
      ),
    ).toContain('"phase": "activated"');
    const credentials = join(
      home,
      ".agent-waker-gemini",
      ".gemini",
      "oauth_creds.json",
    );
    await writeFile(credentials, "fixture-only-provider-owned-content");
    expect(
      await runCli({
        ...environment,
        argv: ["uninstall", "--yes", "--logs"],
        runner: {
          run() {
            return Promise.resolve(completed());
          },
        },
      }),
    ).toBe(0);
    expect(await readFile(credentials, "utf8")).toBe(
      "fixture-only-provider-owned-content",
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it("contains native user-agent discovery and remote card loads before zero-turn auth", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-native-agents-"));
  const workDir = join(home, "work");
  const agentsDir = join(home, ".gemini", "agents");
  const cardUrl = "https://fixture.example.invalid/agent-card.json";
  await mkdir(workDir);
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, "remote.md"),
    `---\nkind: remote\nname: fixture-remote\nagent_card_url: ${cardUrl}\n---\n`,
  );
  const source = await readFile(
    join(import.meta.dirname, "../fixtures/gemini/native-agent-startup.txt"),
    "utf8",
  );
  const nativeCode = transpileModule(source.replaceAll("export ", ""), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
  }).outputText;
  const executable = join(home, "native-agent-startup");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs=require('node:fs');
const path=require('node:path');
const discoveries=[];
const cardLoads=[];
const MergeStrategy={SHALLOW_MERGE:'shallow_merge',CONCAT:'concat',UNION:'union'};
const Storage={getUserAgentsDir:()=>path.join(process.env.GEMINI_CLI_HOME,'.gemini','agents')};
// Directory-loader leaf substitutes native frontmatter parsing for this known
// valid remote definition; card-client leaf records intent without networking.
const loadAgentsFromDirectory=async dir=>{
 discoveries.push(dir);
 if(!fs.existsSync(dir))return {agents:[],errors:[]};
 const text=fs.readFileSync(path.join(dir,'remote.md'),'utf8');
 return {agents:[{kind:'remote',name:/name: (.+)/.exec(text)[1],agentCardUrl:/agent_card_url: (.+)/.exec(text)[1]}],errors:[]};
};
const getAgentCardLoadOptions=definition=>({type:'url',url:definition.agentCardUrl});
const coreEvents={emitFeedback(){}};
const debugLogger={warn(){}};
${nativeCode}
;(async()=>{
 const user=JSON.parse(fs.readFileSync(path.join(process.env.GEMINI_CLI_HOME,'.gemini','settings.json'),'utf8'));
 // Original native deep merge: schema default first, controlled USER scope
 // next; redirected system/default scopes and empty workspace are absent.
 const effective=customDeepMerge(()=>undefined,{experimental:{enableAgents:enableAgentsSchema.enableAgents.default}},user);
 const config={isAgentsEnabled:()=>effective.experimental.enableAgents,getA2AClientManager:()=>({loadAgent:async(name,options)=>{cardLoads.push(options.url)}})};
 await new NativeUserAgentStartup(config).initialize();
 console.log(JSON.stringify({enabled:effective.experimental.enableAgents,discoveries,cardLoads}));
 console.error('[ERROR] '+JSON.stringify({error:{type:'FatalTurnLimitedError',message:'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',code:53}}));
 process.exitCode=53;
})();
`,
  );
  await chmod(executable, 0o700);
  const startup: unknown[] = [];
  const runner = createProcessRunner();
  const context = {
    providerHome: home,
    workDir,
    now: 0,
    runner: {
      async run(spec: ProcessSpec) {
        const result = await runner.run(spec);
        startup.push(JSON.parse(result.stdout) as unknown);
        return result;
      },
    },
  };
  const detection = {
    installed: true,
    health: "ok" as const,
    version: "0.62.0",
    executable,
  };
  try {
    // Uncontrolled native defaults permit the user-level remote card path.
    await writeFile(join(home, ".gemini", "settings.json"), "{}");
    const baseline = await runner.run({
      executable,
      args: [],
      cwd: workDir,
      env: { GEMINI_CLI_HOME: home },
      stdin: "closed",
      timeoutMs: 30_000,
    });
    expect(JSON.parse(baseline.stdout) as unknown).toEqual({
      enabled: true,
      discoveries: [agentsDir],
      cardLoads: [cardUrl],
    });
    const customizedAuth = await createGeminiAdapter().inspectAuth(
      context,
      detection,
    );
    expect(startup).toEqual([]);
    expect(customizedAuth.supportsIntent).toBe(false);
    await rm(agentsDir, { recursive: true });
    expect(
      (await createGeminiAdapter().inspectAuth(context, detection))
        .supportsIntent,
    ).toBe(true);
    expect(startup).toEqual([
      { enabled: false, discoveries: [], cardLoads: [] },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
