// Figma adapter. One interface, two paths:
//   live:     REST API with a READ-ONLY PAT (headless-reliable, used by real runs)
//   fixtures: fixtures/figma-file.json + fixtures/frames/*.png (dry-run)
// The frame-tree parser is shared — only the fetch differs — so a dry run
// exercises the same code the live run will.
// Nothing is ever written back to Figma.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const FIGMA_API = "https://api.figma.com";

async function figmaGet(cfg, urlPath) {
  const res = await fetch(`${FIGMA_API}${urlPath}`, {
    headers: { "X-Figma-Token": cfg.env.FIGMA_PAT },
  });
  if (!res.ok) throw new Error(`Figma ${urlPath} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Shared parser: walk pages -> top-level FRAME nodes, in document order.
 * Document order is the FIFO proxy: designers drop new frames at the end.
 * @returns [{node_id, name, order}]
 */
export function parseCandidateFrames(fileJson) {
  const frames = [];
  let order = 0;
  for (const page of fileJson.document?.children ?? []) {
    for (const node of page.children ?? []) {
      if (node.type === "FRAME") {
        frames.push({ node_id: node.id, name: node.name, order: order++ });
      }
    }
  }
  return frames;
}

/** List candidate frames, oldest-first, from live Figma or fixtures. */
export async function listCandidateFrames(cfg) {
  if (cfg.dryRun) {
    const fixture = path.join(cfg.abs.fixtures_dir, "figma-file.json");
    return parseCandidateFrames(JSON.parse(readFileSync(fixture, "utf8")));
  }
  const fileJson = await figmaGet(cfg, `/v1/files/${cfg.figma.file_key}`);
  return parseCandidateFrames(fileJson);
}

/**
 * Export frames as PNGs into destDir.
 * @returns Map<node_id, absolute file path>
 */
export async function exportFrames(cfg, nodeIds, destDir) {
  mkdirSync(destDir, { recursive: true });
  const out = new Map();

  if (cfg.dryRun) {
    // Fixture node ids map to fixture PNGs via figma-file.json's frame names.
    const fixture = JSON.parse(readFileSync(path.join(cfg.abs.fixtures_dir, "figma-file.json"), "utf8"));
    const byId = new Map(parseCandidateFrames(fixture).map((f) => [f.node_id, f]));
    for (const id of nodeIds) {
      const frame = byId.get(id);
      if (!frame) throw new Error(`fixture frame ${id} not found in figma-file.json`);
      const src = path.join(cfg.abs.fixtures_dir, "frames", `${frame.name}.png`);
      if (!existsSync(src)) throw new Error(`fixture PNG missing: ${src} (run: npm run make-fixtures)`);
      const dest = path.join(destDir, `frame-${id.replace(/[:;]/g, "-")}.png`);
      copyFileSync(src, dest);
      out.set(id, dest);
    }
    return out;
  }

  const ids = nodeIds.join(",");
  const { images, err } = await figmaGet(
    cfg,
    `/v1/images/${cfg.figma.file_key}?ids=${encodeURIComponent(ids)}&format=${cfg.figma.export_format}&scale=${cfg.figma.export_scale}`,
  );
  if (err) throw new Error(`Figma image export error: ${err}`);
  for (const id of nodeIds) {
    const url = images[id];
    if (!url) throw new Error(`Figma returned no image URL for node ${id} (frame deleted mid-run?)`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`image download ${id} -> ${res.status}`);
    const dest = path.join(destDir, `frame-${id.replace(/[:;]/g, "-")}.png`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    out.set(id, dest);
  }
  return out;
}
