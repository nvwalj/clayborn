// Publishing the static half of an agent to GitHub Pages.
//
// An A2A agent is two things: a live endpoint, which needs a running server,
// and a static identity — the card and the public keys, which are just JSON.
// GitHub Pages cannot host the first and is perfect for the second. So
// `publish` writes the card and jwks into a local clone of a Pages repo and
// pushes. The identity base becomes https://<you>.github.io, while the
// endpoint INSIDE the card keeps pointing at whatever ingress provided —
// typically a quick tunnel whose URL changes every boot, which is fine:
// readers re-fetch the card at the stable address to find the current door.
//
// For a person with no domain, GitHub is their DNS. This is optional sugar on
// top of the ingress modes, never a requirement — the rule in
// src/ingress/index.js applies here unchanged.

import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const VERIFY_ATTEMPTS = 18; // × 5s ≈ 90s — first Pages deploys are the slow ones
const VERIFY_GAP_MS = 5000;

function git(repoDir, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoDir, ...args], (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

/**
 * The Pages URL a GitHub remote will serve.
 *   git@github.com:alice/alice.github.io.git → https://alice.github.io
 *   https://github.com/alice/tools.git       → https://alice.github.io/tools
 */
export function deriveBase(remoteUrl) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(String(remoteUrl || "").trim());
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const repo = m[2].toLowerCase();
  return repo === `${owner}.github.io` ? `https://${owner}.github.io` : `https://${owner}.github.io/${repo}`;
}

/**
 * Write card + jwks into the repo, commit and push if anything changed, and
 * (unless told not to) poll the live URL until the new card is actually
 * served — Pages deploys lag pushes by seconds to a minute.
 *
 * Throws on anything that leaves the published identity broken (bad repo, no
 * derivable base, push refused). A verify timeout only warns: the push
 * succeeded, Pages is just slow, and the health of the served card is
 * observable by anyone.
 */
export async function publishToPages({ config, card, jwksDoc, log = console.log, verify = true, fetchImpl = fetch }) {
  const repoDir = path.resolve(String(config.publish.repoDir).replace(/^~(?=$|\/)/, os.homedir()));
  if (!existsSync(repoDir)) throw new Error(`publish.repoDir does not exist: ${repoDir}`);
  await git(repoDir, ["rev-parse", "--git-dir"]).catch(() => {
    throw new Error(`publish.repoDir is not a git repository: ${repoDir}`);
  });

  let base = config.publish.base ? String(config.publish.base).replace(/\/+$/, "") : null;
  if (!base) {
    const remote = await git(repoDir, ["remote", "get-url", "origin"]).catch(() => "");
    base = deriveBase(remote);
    if (!base) {
      throw new Error('cannot derive the Pages URL from the repo\'s origin — set publish.base (e.g. "https://you.github.io")');
    }
  }

  const wk = path.join(repoDir, ".well-known");
  mkdirSync(wk, { recursive: true });
  writeFileSync(path.join(wk, "agent-card.json"), JSON.stringify(card, null, 2) + "\n");
  writeFileSync(path.join(wk, "jwks.json"), JSON.stringify(jwksDoc, null, 2) + "\n");
  // Jekyll — the Pages default build — silently drops dot-directories, and
  // .well-known is one. .nojekyll turns the build off; files serve as written.
  if (!existsSync(path.join(repoDir, ".nojekyll"))) writeFileSync(path.join(repoDir, ".nojekyll"), "");

  const dirty = await git(repoDir, ["status", "--porcelain", ".well-known", ".nojekyll"]);
  if (dirty) {
    await git(repoDir, ["add", ".well-known", ".nojekyll"]);
    await git(repoDir, ["commit", "-m", `clayborn: card for ${card.name}`]);
    await git(repoDir, ["push"]);
    log(`[publish] card + keys pushed — identity lives at ${base}`);
  } else {
    log(`[publish] card unchanged at ${base}`);
  }

  if (verify && dirty) {
    const want = card.supportedInterfaces?.[0]?.url;
    let served = null;
    for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
      try {
        const res = await fetchImpl(`${base}/.well-known/agent-card.json`, { headers: { accept: "application/json" } });
        if (res.ok) {
          const live = await res.json();
          if (live?.supportedInterfaces?.[0]?.url === want) {
            log(`[publish] ${base} is serving the new card`);
            served = live;
            break;
          }
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, VERIFY_GAP_MS));
    }
    if (!served) {
      log(`[publish] WARNING: ${base} is not serving the new card yet — Pages deploys can lag.`);
      log(`[publish] If this is the repo's first deploy, enable Pages: repo settings → Pages → deploy from branch.`);
    }
  }

  return { base };
}
