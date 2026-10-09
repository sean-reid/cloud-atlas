import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ADAPTERS, adapterById } from "./adapters";
import { importCsv } from "./adapters/csv-import";
import { D1HttpDb, localD1Path, SqliteDb, type Db } from "./db";
import { loadReviewed } from "./decisions";
import { fixtureFetch } from "./fixtures";
import { loadGeo } from "./geo";
import { log } from "./log";
import { ensureMethods } from "./methods";
import { runAdapters } from "./run";
import { Store } from "./store";

const ROOT = process.cwd();
const DATA = resolve(ROOT, "data");
const CACHE = resolve(ROOT, ".cache");
const DB_NAME = "cloud-atlas";

const has = (args: string[], name: string) => args.includes(`--${name}`);
const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function wrangler(cmd: string[]): void {
  const r = spawnSync("npx", ["wrangler", ...cmd], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`wrangler ${cmd.join(" ")} failed`);
}

// Local runs open the SQLite file wrangler keeps for the local D1; --remote talks to the
// production database over the D1 HTTP API with the same token the deploy uses.
async function openDb(args: string[]): Promise<Db> {
  if (has(args, "remote")) {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!account || !token)
      throw new Error(
        "--remote needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment",
      );
    return D1HttpDb.connect({ account, token, name: DB_NAME });
  }
  let path = localD1Path(ROOT);
  if (!path) {
    wrangler(["d1", "migrations", "apply", DB_NAME, "--local"]);
    path = localD1Path(ROOT);
  }
  if (!path) throw new Error("local D1 database not found after applying migrations");
  return new SqliteDb(path);
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...args] = argv;
  const dataset = (flag(args, "dataset") ?? "live") as "live" | "demo";

  switch (cmd) {
    case "sources": {
      for (const a of ADAPTERS)
        console.log(`${a.id.padEnd(22)} ${a.mode.padEnd(14)} ${a.schedule.padEnd(8)} ${a.title}`);
      return 0;
    }
    case "migrate": {
      wrangler([
        "d1",
        "migrations",
        "apply",
        DB_NAME,
        has(args, "remote") ? "--remote" : "--local",
      ]);
      return 0;
    }
    case "ingest": {
      const only = args.filter((a) => !a.startsWith("--") && adapterById(a));
      const selected = only.length
        ? ADAPTERS.filter((a) => only.includes(a.id))
        : ADAPTERS.filter((a) => a.schedule !== "manual");
      const db = await openDb(args);
      const offline = has(args, "fixtures");
      const { outcomes } = await runAdapters(selected, {
        db,
        dataRoot: DATA,
        dataset,
        cacheDir: offline ? join(CACHE, "fixtures") : CACHE,
        ...(offline ? { fetchImpl: fixtureFetch(), fetchDefaults: { minIntervalMs: 0 } } : {}),
      });
      await db.close();
      for (const o of outcomes)
        console.log(
          `${o.ok ? "ok  " : "FAIL"} ${o.adapter.padEnd(22)} ${o.ok ? JSON.stringify(o.result) : o.error}`,
        );
      return outcomes.every((o) => o.ok) ? 0 : 1;
    }
    case "import": {
      const files = args.filter((a) => a.endsWith(".csv")).map((f) => resolve(f));
      const list = files.length
        ? files
        : readdirSync(join(DATA, "imports"))
            .filter((f) => f.endsWith(".csv"))
            .sort()
            .map((f) => join(DATA, "imports", f));
      const db = await openDb(args);
      const store = await Store.open(db, dataset);
      await ensureMethods(store);
      const reviewed = loadReviewed(DATA);
      store.aliases = reviewed.aliases;
      store.decisions = reviewed.decisions;
      const geo = loadGeo(DATA);
      const ctx = {
        store,
        dataset,
        now: () => new Date(),
        geo: geo.regions,
        places: geo.places,
        fetch: async () => {
          throw new Error("import does not fetch");
        },
      };
      for (const file of list) {
        const result = await importCsv(ctx, file, "csv-import");
        await store.flush();
        console.log(`${file}: ${JSON.stringify(result)}`);
      }
      await db.close();
      return 0;
    }
    case "review": {
      const db = await openDb(args);
      const store = await Store.open(db, dataset);
      const sub = args[0] ?? "list";
      if (sub === "list") {
        const open = [...store.review.values()].filter((r) => !r.resolved_at);
        for (const r of open) console.log(`${r.id}\n  ${r.adapter}: ${r.reason}`);
        console.log(`${open.length} open item(s)`);
        await db.close();
        return 0;
      }
      const id = args[1];
      const item = id ? store.review.get(id) : undefined;
      if (!item || !id) throw new Error(`unknown review item ${id}`);
      if (sub !== "accept" && sub !== "reject")
        throw new Error("usage: review list | accept <id> [note] | reject <id> [note]");
      const note = args
        .slice(2)
        .filter((a) => !a.startsWith("--"))
        .join(" ");
      await store.resolveReview(id, `${sub}ed${note ? `: ${note}` : ""}`, new Date().toISOString());
      if (sub === "accept") {
        for (const o of store.observations.values()) {
          if (o.review_status === "pending" && item.payload.includes(o.entity_id))
            await store.setReviewStatus(o.id, "accepted");
        }
      }
      await store.flush();
      await db.close();
      console.log(`${sub}ed ${id}`);
      return 0;
    }
    case "health": {
      const db = await openDb(args);
      const store = await Store.open(db, "live");
      const latest = new Map<string, (typeof store.fetchRuns)[number]>();
      for (const r of store.fetchRuns) latest.set(r.adapter, r);
      for (const a of ADAPTERS) {
        const r = latest.get(a.id);
        console.log(
          `${a.id.padEnd(22)} ${r ? `${r.ok ? "ok" : "FAILED"} ${r.finished_at} ${r.error ?? ""}` : "never run"}`,
        );
      }
      await db.close();
      return 0;
    }
    default:
      console.log(
        "usage: cli <sources|migrate|ingest [adapter...] [--fixtures]|import [file.csv...]|review ...|health> [--remote] [--dataset live|demo]",
      );
      return cmd === "help" ? 0 : 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    log("error", "cli.failed", { error: String(err) });
    process.exit(1);
  });
