// `stellar` stand-in for the SPP CLI. The SPP CLI calls an external `stellar`
// binary to sign (overridable with STELLAR_BIN). This script routes a single
// alias, `gd-relay`, to the remote relayer and hands everything else to the
// real `stellar`. So with the official SPP CLI unchanged:
//
//   STELLAR_BIN=<this folder>/stellar.cmd spp --account W --sign-as gd-relay withdraw <pool> 10 --to F
//
// the relayer is the withdrawal's source and fee payer; W's key never leaves
// the machine, and the relayer's key never reaches the agent.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RELAY = process.env.GD_RELAY_URL ?? "http://localhost:8787";
const ALIAS = "gd-relay";
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  // stellar keys public-key gd-relay
  if (args[0] === "keys" && args[1] === "public-key" && args[2] === ALIAS) {
    const info = await fetch(`${RELAY}/relay/info`).then((r) => r.json());
    process.stdout.write(info.address + "\n");
    return 0;
  }
  // stellar tx sign --sign-with-key gd-relay ... (envelope on stdin)
  if (args[0] === "tx" && args[1] === "sign" && flag("--sign-with-key") === ALIAS) {
    const xdr = readFileSync(0, "utf8").trim();
    const r = await fetch(`${RELAY}/relay/spp-sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr }),
    }).then((r) => r.json());
    if (!r.xdr) {
      process.stderr.write(`relayer did not sign: ${r.error}\n`);
      return 1;
    }
    process.stdout.write(r.xdr + "\n");
    return 0;
  }
  const real = process.env.GD_REAL_STELLAR ?? "stellar";
  return spawnSync(real, args, { stdio: "inherit" }).status ?? 1;
}

process.exit(await main());
