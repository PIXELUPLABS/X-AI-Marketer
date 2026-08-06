// Figma adapter. One interface, two paths:
//   live:     REST API with a READ-ONLY PAT (headless-reliable, used by real runs)
//   fixtures: fixtures/figma-file.json + fixtures/frames/*.png (dry-run)
// The frame-tree parser is shared — only the fetch differs — so a dry run
// exercises the same code the live run will.
// Nothing is ever written back to Figma.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const FIGMA_API = "https://api.figma.com";

// Figma's image endpoint renders server-side and will drop the socket on heavy
// requests, so every call gets retries with backoff.
async function fetchWithRetry(url, options, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && attempt < retries) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = 3000 * (attempt + 1);
      console.error(`  figma fetch failed (${err.cause?.code ?? err.message}), retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function figmaGet(cfg, urlPath) {
  const res = await fetchWithRetry(`${FIGMA_API}${urlPath}`, {
    headers: { "X-Figma-Token": cfg.env.FIGMA_PAT },
  });
  if (!res.ok) throw new Error(`Figma ${urlPath} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Shared parser: candidate frames in document order (the FIFO proxy — designers
 * drop new frames at the end).
 *
 * With sectionName set (default "export"), ONLY frames inside the SECTION node
 * with that name (case-insensitive, nested sections included) are candidates —
 * dragging a frame into the section is the clearance act. With sectionName null,
 * falls back to all top-level frames of every page.
 * @returns [{node_id, name, order}]
 */
export function parseCandidateFrames(fileJson, sectionName = null) {
  const frames = [];
  let order = 0;

  const collectFrames = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === "FRAME") frames.push({ node_id: child.id, name: child.name, order: order++ });
      else if (child.type === "SECTION" || child.type === "GROUP") collectFrames(child);
    }
  };

  if (sectionName) {
    const want = sectionName.toLowerCase();
    const findSections = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === "SECTION" && child.name?.trim().toLowerCase() === want) collectFrames(child);
        else findSections(child);
      }
    };
    findSections(fileJson.document ?? {});
    return frames;
  }

  for (const page of fileJson.document?.children ?? []) {
    for (const node of page.children ?? []) {
      if (node.type === "FRAME") frames.push({ node_id: node.id, name: node.name, order: order++ });
    }
  }
  return frames;
}

/** List candidate frames, oldest-first, from live Figma or fixtures. */
export async function listCandidateFrames(cfg) {
  if (cfg.dryRun) {
    const fixture = path.join(cfg.abs.fixtures_dir, "figma-file.json");
    return parseCandidateFrames(JSON.parse(readFileSync(fixture, "utf8")), cfg.figma.section_name);
  }
  const fileJson = await figmaGet(cfg, `/v1/files/${cfg.figma.file_key}`);
  return parseCandidateFrames(fileJson, cfg.figma.section_name);
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
    const byId = new Map(parseCandidateFrames(fixture, cfg.figma.section_name).map((f) => [f.node_id, f]));
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

  // Chunked: one render request per few frames — a single request for the whole
  // batch makes Figma's renderer drop the socket on heavy frames.
  const CHUNK = 4;
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const chunk = nodeIds.slice(i, i + CHUNK);
    console.error(`  exporting frames ${i + 1}-${i + chunk.length} of ${nodeIds.length}...`);
    const { images, err } = await figmaGet(
      cfg,
      `/v1/images/${cfg.figma.file_key}?ids=${encodeURIComponent(chunk.join(","))}&format=${cfg.figma.export_format}&scale=${cfg.figma.export_scale}`,
    );
    if (err) throw new Error(`Figma image export error: ${err}`);
    for (const id of chunk) {
      const url = images[id];
      if (!url) throw new Error(`Figma returned no image URL for node ${id} (frame deleted mid-run?)`);
      const res = await fetchWithRetry(url);
      if (!res.ok) throw new Error(`image download ${id} -> ${res.status}`);
      const dest = path.join(destDir, `frame-${id.replace(/[:;]/g, "-")}.png`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      out.set(id, dest);
    }
  }
  return out;
}
